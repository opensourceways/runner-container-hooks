import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import * as tar from 'tar-fs'
import { execCpFromPod } from '../src/k8s'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

const CONTAINER_TEMP = '/__w/_temp'

// Reproduces the output of the pod-side listing commands without spawning a
// shell, so the tests run the same way on every platform.
function listingFor(dir: string, withMtime: boolean): string {
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
      lines.push(
        withMtime
          ? `${Math.floor(stat.mtimeMs / 1000)} ${stat.size} ./${childRel}`
          : `${stat.size} ./${childRel}`
      )
    }
  }
  visit('')
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

async function packToBuffer(dir: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const pack = tar.pack(dir)
    pack.on('data', (chunk: Buffer) => chunks.push(chunk))
    pack.on('end', () => resolve(Buffer.concat(chunks)))
    pack.on('error', reject)
  })
}

describe('execCpFromPod', () => {
  let execSpy: jest.SpyInstance
  let workDir: string
  let podSideDir: string

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpfrompod-work-'))
    podSideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpfrompod-pod-'))
    execSpy = jest.spyOn(k8s.Exec.prototype, 'exec')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(podSideDir, { recursive: true, force: true })
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['HOOKS_SYNC_MAX_ATTEMPTS']
    delete process.env['HOOKS_SYNC_BACKOFF_BASE_MS']
    delete process.env['HOOKS_SYNC_EXCLUDE']
    delete process.env['HOOKS_SYNC_MODE']
    delete process.env['HOOKS_SYNC_LISTEN_IP']
    delete process.env['HOOKS_SYNC_DIRECT_MAX_FAILURES']
  })

  // Simulate a pod whose `/__w/_temp` is mirrored by a local fixture
  // directory: `tar` commands stream a real archive of the fixture (the same
  // entry layout the pod-side `tar cf - -C /__w _temp` produces), `sh -c`
  // listing commands are answered from the same fixture.
  //
  // `truncateTransfers` cuts the given number of initial archives in half and
  // ends the stream without a terminal status, which is what a peer close on a
  // slow exec channel leaves behind.
  //
  // `badToken` makes the direct-mode sender authenticate with the wrong token,
  // which must be rejected before any byte reaches the staging directory.
  function mockPodSide(
    behavior: { truncateTransfers?: number; badToken?: boolean } = {}
  ): void {
    let truncationsLeft = behavior.truncateTransfers ?? 0
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
        if (command[0] === 'tar') {
          const archive = await packToBuffer(podSideDir)
          if (truncationsLeft > 0) {
            truncationsLeft--
            stdout.write(
              archive.subarray(0, Math.max(1, Math.floor(archive.length / 2)))
            )
            stdout.end()
            return Promise.resolve()
          }
          stdout.write(archive)
          stdout.end()
          callback({ status: 'Success' })
          return Promise.resolve()
        }
        if (command[0] === 'bash') {
          // Direct mode: the pod-side command opens one connection to
          // /dev/tcp/<runner ip>/<port>, sends the token, then streams tar.
          // Reproduce both steps over a real socket so the runner side sees
          // exactly the wire format it validates.
          const match = /\/dev\/tcp\/([^/\s]+)\/(\d+)/.exec(command[2])
          const token = /printf '%s\\n' '([0-9a-fA-F]+)'/.exec(command[2])
          if (match && token) {
            const sentToken = behavior.badToken ? 'deadbeef' : token[1]
            const archive = await packToBuffer(podSideDir)
            await new Promise<void>((resolve, reject) => {
              const socket = net.connect(Number(match[2]), match[1], () => {
                socket.write(`${sentToken}\n`)
                socket.write(archive)
                socket.end()
              })
              socket.on('close', () => resolve())
              socket.on('error', reject)
            })
            callback({ status: 'Success' })
            return Promise.resolve()
          }
        }
        const script = command[2]
        stdout.write(
          listingFor(
            path.join(podSideDir, '_temp'),
            script.includes("stat -c '%Y")
          )
        )
        callback({ status: 'Success' })
        return Promise.resolve()
      }
    )
  }

  it('replaces the target with the staged copy and drops stale files', async () => {
    const podTemp = path.join(podSideDir, '_temp')
    fs.mkdirSync(path.join(podTemp, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(podTemp, 'actionlint.json'), 'A')
    fs.writeFileSync(path.join(podTemp, 'mypy.json'), 'M')
    fs.writeFileSync(path.join(podTemp, 'nested', 'inner.txt'), 'N')

    // Previous runner-side snapshot: outdated content plus a stale file that
    // the pod deleted. Both must be gone after the sync.
    const target = path.join(workDir, '_temp')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'stale.txt'), 'stale')
    fs.writeFileSync(path.join(target, 'actionlint.json'), 'OLD')

    mockPodSide()

    await execCpFromPod('test-pod', CONTAINER_TEMP, workDir)

    expect(fs.existsSync(path.join(target, 'stale.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(target, 'actionlint.json'), 'utf8')).toBe(
      'A'
    )
    expect(fs.readFileSync(path.join(target, 'mypy.json'), 'utf8')).toBe('M')
    expect(
      fs.readFileSync(path.join(target, 'nested', 'inner.txt'), 'utf8')
    ).toBe('N')

    // staging and trash directories must not linger next to the target
    expect(fs.readdirSync(workDir).sort()).toEqual(['_temp'])
  })

  it('publishes the staged copy when the target does not exist yet', async () => {
    const podTemp = path.join(podSideDir, '_temp')
    fs.mkdirSync(podTemp, { recursive: true })
    fs.writeFileSync(path.join(podTemp, 'file.txt'), 'content')

    mockPodSide()

    await execCpFromPod('test-pod', CONTAINER_TEMP, workDir)

    expect(
      fs.readFileSync(path.join(workDir, '_temp', 'file.txt'), 'utf8')
    ).toBe('content')
    expect(fs.readdirSync(workDir).sort()).toEqual(['_temp'])
  })

  it('syncs over the direct pod-to-pod channel when HOOKS_SYNC_MODE=direct', async () => {
    process.env['HOOKS_SYNC_MODE'] = 'direct'
    process.env['HOOKS_SYNC_LISTEN_IP'] = '127.0.0.1'

    const podTemp = path.join(podSideDir, '_temp')
    fs.mkdirSync(path.join(podTemp, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(podTemp, 'direct.txt'), 'via socket')
    fs.writeFileSync(path.join(podTemp, 'nested', 'inner.txt'), 'N')

    mockPodSide()

    await execCpFromPod('test-pod', CONTAINER_TEMP, workDir)

    expect(
      fs.readFileSync(path.join(workDir, '_temp', 'direct.txt'), 'utf8')
    ).toBe('via socket')
    expect(
      fs.readFileSync(
        path.join(workDir, '_temp', 'nested', 'inner.txt'),
        'utf8'
      )
    ).toBe('N')
    expect(fs.readdirSync(workDir).sort()).toEqual(['_temp'])
  })

  it('rejects a direct connection with the wrong token and falls back to exec', async () => {
    process.env['HOOKS_SYNC_MODE'] = 'direct'
    process.env['HOOKS_SYNC_LISTEN_IP'] = '127.0.0.1'

    const podTemp = path.join(podSideDir, '_temp')
    fs.mkdirSync(podTemp, { recursive: true })
    fs.writeFileSync(path.join(podTemp, 'secret.txt'), 'payload')

    mockPodSide({ badToken: true })

    await execCpFromPod('test-pod', CONTAINER_TEMP, workDir)

    expect(
      fs.readFileSync(path.join(workDir, '_temp', 'secret.txt'), 'utf8')
    ).toBe('payload')
    expect(fs.readdirSync(workDir).sort()).toEqual(['_temp'])
  })

  it('disables direct mode after consecutive failures even when exec fallback succeeds', async () => {
    process.env['HOOKS_SYNC_MODE'] = 'direct'
    process.env['HOOKS_SYNC_LISTEN_IP'] = '127.0.0.1'
    process.env['HOOKS_SYNC_DIRECT_MAX_FAILURES'] = '2'

    const podTemp = path.join(podSideDir, '_temp')
    fs.mkdirSync(podTemp, { recursive: true })
    const payloadPath = path.join(podTemp, 'payload.txt')

    const directAttempts = (): number =>
      execSpy.mock.calls.filter(
        call => (call[3] as string[])[0] === 'bash'
      ).length

    // Reset the module-level failure counter to zero with one successful
    // direct transfer. Distinct sizes keep the unchanged-sync shortcut from
    // skipping any of the transfers below.
    mockPodSide()
    fs.writeFileSync(payloadPath, 'a')
    await execCpFromPod('test-pod', CONTAINER_TEMP, workDir)

    // Two bad-token syncs: each attempts direct, fails, then falls back to
    // exec successfully. The successful exec fallback must NOT reset the
    // counter, or the disable-after-N guard would never trip.
    mockPodSide({ badToken: true })
    execSpy.mockClear()
    fs.writeFileSync(payloadPath, 'bb')
    await execCpFromPod('test-pod', CONTAINER_TEMP, workDir)
    fs.writeFileSync(payloadPath, 'ccc')
    await execCpFromPod('test-pod', CONTAINER_TEMP, workDir)
    expect(directAttempts()).toBe(2)

    // Third sync: the counter has reached the cap, so direct is skipped and
    // the copy goes straight to exec.
    execSpy.mockClear()
    fs.writeFileSync(payloadPath, 'dddd')
    await execCpFromPod('test-pod', CONTAINER_TEMP, workDir)
    expect(
      fs.readFileSync(path.join(workDir, '_temp', 'payload.txt'), 'utf8')
    ).toBe('dddd')
    expect(directAttempts()).toBe(0)
  })

  it('retries a truncated stream and publishes the complete copy', async () => {
    process.env['HOOKS_SYNC_BACKOFF_BASE_MS'] = '1'

    const podTemp = path.join(podSideDir, '_temp')
    fs.mkdirSync(podTemp, { recursive: true })
    fs.writeFileSync(path.join(podTemp, 'new.txt'), 'new')

    const target = path.join(workDir, '_temp')
    fs.mkdirSync(target, { recursive: true })
    // Deliberately different size from new.txt so the unchanged-sync shortcut
    // cannot hide the truncated transfer.
    fs.writeFileSync(path.join(target, 'old.txt'), 'old snapshot')

    mockPodSide({ truncateTransfers: 1 })

    await execCpFromPod('test-pod', CONTAINER_TEMP, workDir)

    expect(fs.readFileSync(path.join(target, 'new.txt'), 'utf8')).toBe('new')
    expect(fs.existsSync(path.join(target, 'old.txt'))).toBe(false)
    expect(fs.readdirSync(workDir).sort()).toEqual(['_temp'])
  })

  it('fails cleanly after repeated truncations without publishing staging', async () => {
    process.env['HOOKS_SYNC_MAX_ATTEMPTS'] = '3'
    process.env['HOOKS_SYNC_BACKOFF_BASE_MS'] = '1'

    const podTemp = path.join(podSideDir, '_temp')
    fs.mkdirSync(podTemp, { recursive: true })
    fs.writeFileSync(path.join(podTemp, 'new.txt'), 'new')

    // Old snapshot: must survive untouched because the transfer never
    // completed.
    const target = path.join(workDir, '_temp')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'old.txt'), 'old snapshot')

    mockPodSide({ truncateTransfers: 100 })

    await expect(
      execCpFromPod('test-pod', CONTAINER_TEMP, workDir)
    ).rejects.toThrow(/incomplete transfer/)

    expect(fs.readFileSync(path.join(target, 'old.txt'), 'utf8')).toBe(
      'old snapshot'
    )
    expect(fs.existsSync(path.join(target, 'new.txt'))).toBe(false)
    // Neither a partial staging directory nor a trash copy may remain.
    expect(fs.readdirSync(workDir).sort()).toEqual(['_temp'])
    expect(fs.existsSync(path.join(workDir, '._temp.incoming'))).toBe(false)
    expect(fs.existsSync(path.join(workDir, '._temp.trash'))).toBe(false)
  })
})
