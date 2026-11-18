import * as k8s from '@kubernetes/client-node'
import { EventEmitter } from 'events'
import { execPodStep } from '../src/k8s'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

class FakeSocket extends EventEmitter {
  readyState = 1
  ping = jest.fn()
  close = jest.fn(() => {
    this.readyState = 3
  })
}

describe('execPodStep', () => {
  let execSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    execSpy = jest.spyOn(k8s.Exec.prototype, 'exec')
  })
  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('resolves 0 on Success', async () => {
    execSpy.mockImplementation(
      async (_n, _p, _c, _cmd, _so, _se, _si, _t, cb) => {
        cb({ status: 'Success', code: 0 })
        return Promise.resolve()
      }
    )
    await expect(execPodStep(['true'], 'p', 'job')).resolves.toBe(0)
  })

  it('rejects on Failure status', async () => {
    execSpy.mockImplementation(
      async (_n, _p, _c, _cmd, _so, _se, _si, _t, cb) => {
        cb({ status: 'Failure', message: 'boom' })
        return Promise.resolve()
      }
    )
    await expect(execPodStep(['false'], 'p', 'job')).rejects.toThrow('boom')
  })

  it('fails the step when the exec socket closes before a terminal status', async () => {
    execSpy.mockImplementation(async () => {
      const ws = new FakeSocket()
      setTimeout(() => ws.emit('close'), 0)
      return ws
    })
    await expect(execPodStep(['sh'], 'p', 'job')).rejects.toThrow(
      /terminal state|interrupted/
    )
  })
})
