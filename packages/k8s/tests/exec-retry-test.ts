import * as k8s from '@kubernetes/client-node'
import { createHash } from 'crypto'
import {
  execCalculateOutputHashSorted,
  execPodStep,
  execPodStepWithOutput
} from '../src/k8s'
import { isExecDialError, RetryK8sApiCallOptions } from '../src/k8s/utils'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

// Keep retries deterministic and fast: the default backoff is seconds long.
const fastRetry: RetryK8sApiCallOptions = {
  attempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2
}

// The exact shape observed on the HK CI nodes when the apiserver could not
// reach kubelet:10250.
const DIAL_TIMEOUT = new Error(
  'Internal error occurred: error sending request for url (https://172.16.1.121:10250/exec/sh): dial tcp 172.16.1.121:10250: i/o timeout'
)

describe('isExecDialError', () => {
  it('detects the apiserver to kubelet dial timeout', () => {
    expect(isExecDialError(DIAL_TIMEOUT)).toBe(true)
  })

  it('detects transport codes for an unreachable kubelet', () => {
    expect(isExecDialError({ code: 'EHOSTUNREACH' })).toBe(true)
    expect(
      isExecDialError({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
    ).toBe(true)
  })

  it('never treats a script exit as a dial failure', () => {
    expect(
      isExecDialError(
        new Error(
          'dial tcp 10.0.0.1:10250: i/o timeout; command terminated with exit code 1'
        )
      )
    ).toBe(false)
    expect(
      isExecDialError(new Error('command terminated with exit code 1'))
    ).toBe(false)
  })

  it('ignores unrelated failures', () => {
    expect(isExecDialError(new Error('container not found'))).toBe(false)
    expect(isExecDialError(null)).toBe(false)
    expect(isExecDialError(undefined)).toBe(false)
  })
})

describe('exec retries', () => {
  let execSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    execSpy = jest.spyOn(k8s.Exec.prototype, 'exec')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('retries execPodStep after a dial timeout and then succeeds', async () => {
    execSpy
      .mockImplementationOnce(async () => {
        throw DIAL_TIMEOUT
      })
      .mockImplementationOnce(
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
          callback({ status: 'Success', code: 0 })
          return Promise.resolve()
        }
      )

    const code = await execPodStep(
      ['sh', '-c', 'echo hi'],
      'test-pod',
      'job',
      undefined,
      fastRetry
    )

    expect(code).toBe(0)
    expect(execSpy).toHaveBeenCalledTimes(2)
  })

  it('does not retry execPodStep when the script exits non-zero', async () => {
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
        callback({
          status: 'Failure',
          message: 'command terminated with exit code 7'
        })
        return Promise.resolve()
      }
    )

    await expect(
      execPodStep(
        ['sh', '-c', 'exit 7'],
        'test-pod',
        'job',
        undefined,
        fastRetry
      )
    ).rejects.toThrow('exit code 7')
    expect(execSpy).toHaveBeenCalledTimes(1)
  })

  it('does not retry execPodStep on an unrelated failure', async () => {
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
      execPodStep(['echo'], 'test-pod', 'job', undefined, fastRetry)
    ).rejects.toThrow('container not found')
    expect(execSpy).toHaveBeenCalledTimes(1)
  })

  it('gives up after the retry budget when kubelet stays unreachable', async () => {
    execSpy.mockImplementation(async () => {
      throw DIAL_TIMEOUT
    })

    await expect(
      execPodStep(['echo'], 'test-pod', 'job', undefined, fastRetry)
    ).rejects.toThrow('i/o timeout')
    expect(execSpy).toHaveBeenCalledTimes(3)
  })

  it('retries execPodStepWithOutput without duplicating the captured output', async () => {
    execSpy
      .mockImplementationOnce(async () => {
        throw DIAL_TIMEOUT
      })
      .mockImplementationOnce(
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
          callback({ status: 'Success', code: 0 })
          return Promise.resolve()
        }
      )

    const { code, output } = await execPodStepWithOutput(
      ['sh', '-c', 'echo hello'],
      'test-pod',
      'job',
      20,
      undefined,
      fastRetry
    )

    expect(code).toBe(0)
    expect(output).toBe('hello from script')
    expect(execSpy).toHaveBeenCalledTimes(2)
  })

  it('does not retry execPodStepWithOutput when the script exits non-zero', async () => {
    execSpy.mockImplementationOnce(async () =>
      Promise.reject(
        new Error(
          'command terminated with non-zero exit code: command terminated with exit code 154'
        )
      )
    )

    const { code } = await execPodStepWithOutput(
      ['sh', '-c', 'exit 154'],
      'test-pod',
      'job',
      20,
      undefined,
      fastRetry
    )

    expect(code).toBe(154)
    expect(execSpy).toHaveBeenCalledTimes(1)
  })

  it('retries execCalculateOutputHashSorted and hashes a single run', async () => {
    execSpy
      .mockImplementationOnce(async () => {
        throw DIAL_TIMEOUT
      })
      .mockImplementationOnce(
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
          stdout.write('b\na\n')
          callback({ status: 'Success' })
          return Promise.resolve()
        }
      )

    const { hash, lines } = await execCalculateOutputHashSorted(
      'test-pod',
      'job',
      ['sh', '-c', 'ls'],
      fastRetry
    )

    const expected = createHash('sha256').update('a\nb\n').digest('hex')
    expect(lines).toEqual(['a', 'b'])
    expect(hash).toBe(expected)
    expect(execSpy).toHaveBeenCalledTimes(2)
  })
})
