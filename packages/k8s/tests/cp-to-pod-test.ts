import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import * as tar from 'tar-fs'
import { execCpToPod } from '../src/k8s'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

const CONTAINER_PATH = '/__w'

// Reproduces the `sh -c` listing output the hash-verification step reads,
// without spawning a shell. `listDirAllCommand` uses `stat -c '%s %n'`.
function listingFor(dir: string): string {
  const lines: string[] = []
  const visit = (relative: string): void => {
    const current = relative ? path.join(dir, relative) : dir
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = relative ? `${relative}/${child.name}` : child.name
      if (child.isDirectory()) {
        visit(childRel)
        continue
      }
      const stat = fs.statSync(path.join(dir, childRel))
      lines.push(`${stat.size} ./${childRel}`)
    }
  }
  visit('')
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

describe('execCpToPod', () => {
  let execSpy: jest.SpyInstance
  let runnerDir: string
  let podSideDir: string

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cptopod-runner-'))
    podSideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cptopod-pod-'))
    execSpy = jest.spyOn(k8s.Exec.prototype, 'exec')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    fs.rmSync(runnerDir, { recursive: true, force: true })
    fs.rmSync(podSideDir, { recursive: true, force: true })
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['HOOKS_SYNC_MODE']
    delete process.env['HOOKS_SYNC_LISTEN_IP']
    delete process.env['HOOKS_SYNC_DIRECT_MAX_FAILURES']
    delete process.env['HOOKS_SYNC_DIRECT_TIMEOUT_MS']
  })

  // Simulates the pod side of a direct push: the exec command opens a
  // /dev/tcp connection back to the runner, sends the one-time token, then
  // receives the tar stream and extracts it into the pod fixture directory.
  function mockDirectPodSide(
    behavior: { probeConnections?: number } = {}
  ): void {
    execSpy.mockImplementation(
      async (
        _ns: unknown,
        _pod: unknown,
        _container: unknown,
        command: string[],
        stdout: NodeJS.WritableStream,
        _stderr: unknown,
        _stdin: unknown,
        _tty: boolean,
        callback: (resp: { status: string }) => void
      ) => {
        if (command[0] === 'bash') {
          const match = /\/dev\/tcp\/([^/\s]+)\/(\d+)/.exec(command[2])
          const token = /printf '%s\\n' '([0-9a-fA-F]+)'/.exec(command[2])
          if (match && token) {
            // An unauthenticated prober connects first; the listener must
            // drop it and still accept the real job connection.
            for (let i = 0; i < (behavior.probeConnections ?? 0); i++) {
              await new Promise<void>(resolve => {
                const probe = net.connect(Number(match[2]), match[1], () => {
                  probe.write('deadbeef\n')
                })
                probe.on('close', () => resolve())
                probe.on('error', () => resolve())
              })
            }
            await new Promise<void>((resolve, reject) => {
              const socket = net.connect(Number(match[2]), match[1], () => {
                socket.write(`${token[1]}\n`)
              })
              const extract = tar.extract(podSideDir)
              socket.pipe(extract)
              extract.on('finish', () => resolve())
              socket.on('error', reject)
              extract.on('error', reject)
            })
            callback({ status: 'Success' })
            return Promise.resolve()
          }
        }
        // Hash-verification listing command. The pod-side fixture mirrors the
        // runner directory (tar preserves mtime and size), so return the
        // listing from the runner copy to make verification converge fast.
        stdout.write(listingFor(runnerDir))
        callback({ status: 'Success' })
        return Promise.resolve()
      }
    )
  }

  it('pushes the workspace over the direct channel when HOOKS_SYNC_MODE=direct', async () => {
    process.env['HOOKS_SYNC_MODE'] = 'direct'
    process.env['HOOKS_SYNC_LISTEN_IP'] = '127.0.0.1'
    process.env['HOOKS_SYNC_DIRECT_TIMEOUT_MS'] = '20000'

    fs.mkdirSync(path.join(runnerDir, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(runnerDir, 'main.py'), 'print(1)')
    fs.writeFileSync(path.join(runnerDir, 'nested', 'inner.txt'), 'N')

    mockDirectPodSide()

    await execCpToPod('test-pod', runnerDir, CONTAINER_PATH)

    expect(fs.readFileSync(path.join(podSideDir, 'main.py'), 'utf8')).toBe(
      'print(1)'
    )
    expect(
      fs.readFileSync(path.join(podSideDir, 'nested', 'inner.txt'), 'utf8')
    ).toBe('N')
    // The direct path issues a bash command; no `sh -c tar xf` exec push.
    const bashCalls = execSpy.mock.calls.filter(
      call => (call[3] as string[])[0] === 'bash'
    )
    expect(bashCalls.length).toBeGreaterThan(0)
  })

  it('drops an unauthenticated probe connection without failing the direct push', async () => {
    process.env['HOOKS_SYNC_MODE'] = 'direct'
    process.env['HOOKS_SYNC_LISTEN_IP'] = '127.0.0.1'
    process.env['HOOKS_SYNC_DIRECT_MAX_FAILURES'] = '1'

    fs.writeFileSync(path.join(runnerDir, 'payload.txt'), 'direct')

    mockDirectPodSide({ probeConnections: 1 })

    await execCpToPod('test-pod', runnerDir, CONTAINER_PATH)

    expect(fs.readFileSync(path.join(podSideDir, 'payload.txt'), 'utf8')).toBe(
      'direct'
    )
    // No exec fallback: a bad-token probe must not consume the attempt.
    const shPushCalls = execSpy.mock.calls.filter(
      call =>
        (call[3] as string[])[0] === 'sh' &&
        String((call[3] as string[])[2]).includes('tar xf -')
    )
    expect(shPushCalls).toHaveLength(0)
  })

  // The pod-side push reports a non-Success exec status (a failed tar
  // extraction, e.g. the data/IO errors the blocklist marks as fatal) for
  // the given number of initial attempts, then really extracts.
  function mockExecPodSide(
    behavior: { failPushStatuses?: number; neverExtract?: boolean } = {}
  ): void {
    let pushFailuresLeft = behavior.failPushStatuses ?? 0
    execSpy.mockImplementation(
      async (
        _ns: unknown,
        _pod: unknown,
        _container: unknown,
        command: string[],
        stdout: NodeJS.WritableStream,
        _stderr: unknown,
        stdin: NodeJS.ReadableStream | null,
        _tty: boolean,
        callback: (resp: { status: string }) => void
      ) => {
        if (command[0] === 'sh' && String(command[2]).includes('tar xf -')) {
          if (pushFailuresLeft > 0) {
            pushFailuresLeft--
            callback({ status: 'Failure' })
            return Promise.resolve()
          }
          if (behavior.neverExtract) {
            // Pod claims success but nothing lands on disk: the case that
            // used to pass silently and produce an empty workspace.
            callback({ status: 'Success' })
            return Promise.resolve()
          }
          await new Promise<void>((resolve, reject) => {
            const extract = tar.extract(podSideDir)
            stdin!.pipe(extract)
            extract.on('finish', () => resolve())
            extract.on('error', reject)
          })
          callback({ status: 'Success' })
          return Promise.resolve()
        }
        // Hash-verification listing command. Answer from the runner fixture
        // unless the pod side is deliberately broken.
        stdout.write(behavior.neverExtract ? '' : listingFor(runnerDir))
        callback({ status: 'Success' })
        return Promise.resolve()
      }
    )
  }

  it('rejects a failing pod-side exec status and retries until the push succeeds', async () => {
    fs.writeFileSync(path.join(runnerDir, 'retry.txt'), 'retry-me')

    mockExecPodSide({ failPushStatuses: 2 })

    await execCpToPod('test-pod', runnerDir, CONTAINER_PATH)

    const pushCalls = execSpy.mock.calls.filter(
      call =>
        (call[3] as string[])[0] === 'sh' &&
        String((call[3] as string[])[2]).includes('tar xf -')
    )
    // Two rejections must have triggered two retries before the success.
    expect(pushCalls.length).toBeGreaterThanOrEqual(3)
    expect(fs.readFileSync(path.join(podSideDir, 'retry.txt'), 'utf8')).toBe(
      'retry-me'
    )
  }, 15000)

  it('throws when the listing verification never converges', async () => {
    fs.writeFileSync(path.join(runnerDir, 'content.txt'), 'real content')

    // A pod that reports Success but never materializes the files: this
    // used to pass silently and leave an empty workspace downstream.
    mockExecPodSide({ neverExtract: true })

    await expect(
      execCpToPod('test-pod', runnerDir, CONTAINER_PATH)
    ).rejects.toThrow(/did not converge/)
  }, 45000)
})
