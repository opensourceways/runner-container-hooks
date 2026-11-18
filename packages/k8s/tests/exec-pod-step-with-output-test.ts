import * as k8s from '@kubernetes/client-node'
import { EventEmitter } from 'events'
import { execPodStepWithOutput } from '../src/k8s'

// Stand-in for the isomorphic-ws socket client-node's exec() resolves with
// once the connection is open.
class FakeSocket extends EventEmitter {
  readyState = 1
  ping = jest.fn()
  close = jest.fn(() => {
    this.readyState = 3
  })
}

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

describe('execPodStepWithOutput', () => {
  let execSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    execSpy = jest.spyOn(k8s.Exec.prototype, 'exec')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('resolves with code 0 and captured stdout on success', async () => {
    execSpy.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        stdout,
        _stderr,
        _stdin,
        _tty,
        callback
      ) => {
        stdout.write('hello from script\n')
        stdout.write('second line\n')
        callback({ status: 'Success', code: 0 })
        return Promise.resolve()
      }
    )
    const { code, output } = await execPodStepWithOutput(
      ['sh', '-c', 'echo hello'],
      'test-pod',
      'job'
    )
    expect(code).toBe(0)
    expect(output).toContain('hello from script')
    expect(output).toContain('second line')
  })

  it('resolves with exit code when exec() promise rejects with non-zero exit message', async () => {
    // This is the k8s client v1.x path: exec() rejects directly, callback never fires.
    execSpy.mockImplementation(async (_ns, _pod, _container, _cmd, stdout) => {
      stdout.write('some output before fail\n')
      return Promise.reject(
        new Error(
          'command terminated with non-zero exit code: command terminated with exit code 154'
        )
      )
    })
    const { code, output } = await execPodStepWithOutput(
      ['sh', '-c', 'exit 154'],
      'test-pod',
      'job'
    )
    expect(code).toBe(154)
    expect(output).toContain('some output before fail')
  })

  it('resolves with exit code from Failure status callback', async () => {
    execSpy.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        _stdout,
        stderr,
        _stdin,
        _tty,
        callback
      ) => {
        stderr.write('error output\n')
        callback({
          status: 'Failure',
          message: 'command terminated with exit code 1'
        })
        return Promise.resolve()
      }
    )
    const { code, output } = await execPodStepWithOutput(
      ['sh', '-c', 'exit 1'],
      'test-pod',
      'job'
    )
    expect(code).toBe(1)
    expect(output).toContain('error output')
  })

  it('rejects on genuine exec failure (no exit code in error message)', async () => {
    execSpy.mockReturnValue(
      Promise.reject(new Error('websocket: connection refused'))
    )
    await expect(
      execPodStepWithOutput(['echo', 'hi'], 'test-pod', 'job')
    ).rejects.toThrow('websocket: connection refused')
  })

  it('rejects on Failure callback with no exit code in message', async () => {
    execSpy.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        _stdout,
        _stderr,
        _stdin,
        _tty,
        callback
      ) => {
        callback({ status: 'Failure', message: 'container not found' })
        return Promise.resolve()
      }
    )
    await expect(
      execPodStepWithOutput(['echo'], 'test-pod', 'job')
    ).rejects.toThrow('container not found')
  })

  it('retains only the last tailLines lines in the output buffer', async () => {
    execSpy.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        stdout,
        _stderr,
        _stdin,
        _tty,
        callback
      ) => {
        for (let i = 0; i < 30; i++) {
          stdout.write(`line ${i}\n`)
        }
        callback({ status: 'Success', code: 0 })
        return Promise.resolve()
      }
    )
    const { code, output } = await execPodStepWithOutput(
      ['cmd'],
      'test-pod',
      'job',
      5 // tailLines = 5
    )
    expect(code).toBe(0)
    const lines = output.split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(5)
    expect(output).toContain('line 29')
    expect(output).not.toContain('line 0')
  })

  it('keeps stdout and stderr pending buffers independent (no interleaving)', async () => {
    execSpy.mockImplementation(
      async (
        _ns,
        _pod,
        _container,
        _cmd,
        stdout,
        stderr,
        _stdin,
        _tty,
        callback
      ) => {
        // Write partial lines to both streams without a newline delimiter.
        // If the pending buffers were shared, "out partial" and "err partial"
        // would be concatenated into one corrupted line.
        stdout.write('out partial')
        stderr.write('err partial')
        stdout.write(' continued\n') // completes the stdout line
        stderr.write(' done\n') // completes the stderr line
        callback({ status: 'Success', code: 0 })
        return Promise.resolve()
      }
    )
    const { output } = await execPodStepWithOutput(['cmd'], 'test-pod', 'job')
    expect(output).toContain('out partial continued')
    expect(output).toContain('err partial done')
    // The two partial writes must NOT be merged into a single corrupted line
    expect(output).not.toContain('out partialerr partial')
    expect(output).not.toContain('err partialout partial')
  })

  it('fails the step when the exec socket closes before any terminal status', async () => {
    // Reproduces the silently-green incident: an intermediary (idle proxy/edge
    // timeout during a long quiet step) severs the exec stream. No Success or
    // Failure status frame ever arrives, so the step must NOT be trusted.
    execSpy.mockImplementation(async () => {
      const ws = new FakeSocket()
      setTimeout(() => ws.emit('close'), 0)
      return ws
    })
    await expect(
      execPodStepWithOutput(['sh', '-c', 'sleep 999'], 'test-pod', 'job')
    ).rejects.toThrow(/terminal state|interrupted/)
  })

  it('does not retry (double-execute) a session that dies after it started', async () => {
    // Complements the dial-retry work: a socket that errors MID-run must fail
    // once, not be re-run. Even if the underlying socket error looks like a
    // dial failure, the guard replaces it with a non-dial message.
    let calls = 0
    execSpy.mockImplementation(async () => {
      calls++
      const ws = new FakeSocket()
      setTimeout(
        () => ws.emit('error', new Error('read ECONNRESET ... i/o timeout')),
        0
      )
      return ws
    })
    await expect(
      execPodStepWithOutput(['sh', '-c', 'sleep 999'], 'test-pod', 'job')
    ).rejects.toThrow(/terminal state|interrupted/)
    expect(calls).toBe(1)
  })

  it('resolves on Success and is not broken by the later clean socket close', async () => {
    // Guards against turning the fix into false failures: a real command
    // finishes (Success), and only then does the server close the socket.
    execSpy.mockImplementation(
      async (_ns, _pod, _c, _cmd, stdout, _se, _si, _tty, callback) => {
        const ws = new FakeSocket()
        stdout.write('all done\n')
        callback({ status: 'Success', code: 0 })
        setTimeout(() => ws.emit('close'), 0)
        return ws
      }
    )
    const { code, output } = await execPodStepWithOutput(
      ['cmd'],
      'test-pod',
      'job'
    )
    expect(code).toBe(0)
    expect(output).toContain('all done')
  })
})
