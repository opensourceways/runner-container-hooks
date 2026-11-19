import * as k8s from '@kubernetes/client-node'
import { execSync } from 'child_process'
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
  })

  // Simulate a pod whose `/__w/_temp` is mirrored by a local fixture
  // directory: `tar` commands stream a real archive of the fixture (the same
  // entry layout the pod-side `tar cf - -C /__w _temp` produces), `sh -c`
  // listing commands are re-run locally against the fixture.
  function mockPodSide() {
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
          const pack = tar.pack(podSideDir)
          pack.pipe(stdout)
          pack.on('end', () => callback({ status: 'Success' }))
          return Promise.resolve()
        }
        const rewritten = (command[2] as string).replace(
          CONTAINER_TEMP,
          path.join(podSideDir, '_temp')
        )
        const out = execSync(rewritten).toString()
        stdout.write(out)
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
})
