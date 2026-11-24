import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
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
  })

  // Simulate a pod whose `/__w/_temp` is mirrored by a local fixture
  // directory: `tar` commands stream a real archive of the fixture (the same
  // entry layout the pod-side `tar cf - -C /__w _temp` produces), `sh -c`
  // listing commands are answered from the same fixture.
  //
  // `truncateTransfers` cuts the given number of initial archives in half and
  // ends the stream without a terminal status, which is what a peer close on a
  // slow exec channel leaves behind.
  function mockPodSide(behavior: { truncateTransfers?: number } = {}): void {
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
