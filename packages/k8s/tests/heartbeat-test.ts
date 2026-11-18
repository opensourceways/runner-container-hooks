import { EventEmitter } from 'events'
import { WebSocketHeartbeat, parsePositiveMsEnv } from '../src/k8s/heartbeat'

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

describe('parsePositiveMsEnv', () => {
  it('falls back on missing / non-positive / non-numeric values', () => {
    expect(parsePositiveMsEnv(undefined, 100)).toBe(100)
    expect(parsePositiveMsEnv('', 100)).toBe(100)
    expect(parsePositiveMsEnv('0', 100)).toBe(100)
    expect(parsePositiveMsEnv('-5', 100)).toBe(100)
    expect(parsePositiveMsEnv('abc', 100)).toBe(100)
    expect(parsePositiveMsEnv('250', 100)).toBe(250)
  })
})

describe('WebSocketHeartbeat', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('does not arm the deadline until the first ping is sent', () => {
    const ws = new FakeSocket()
    const onDead = jest.fn()
    const hb = new WebSocketHeartbeat(1000, 3000)
    hb.start(ws, onDead)

    jest.advanceTimersByTime(999)
    expect(ws.ping).not.toHaveBeenCalled()
    // No pong exchange yet, so a long gap here must not trip the deadline.
    jest.advanceTimersByTime(2999)
    expect(onDead).not.toHaveBeenCalled()
    hb.stop()
  })

  it('declares the connection dead when no pong follows a ping', () => {
    const ws = new FakeSocket()
    const onDead = jest.fn()
    const hb = new WebSocketHeartbeat(1000, 3000)
    hb.start(ws, onDead)

    jest.advanceTimersByTime(1000) // first ping arms the deadline
    expect(ws.ping).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(3000) // deadline elapses with no pong

    expect(ws.close).toHaveBeenCalled()
    expect(onDead).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('no pong') })
    )
  })

  it('keeps the step alive while the socket answers pings', () => {
    const ws = new FakeSocket()
    ws.ping = jest.fn(() => {
      ws.emit('pong')
    })
    const onDead = jest.fn()
    const hb = new WebSocketHeartbeat(1000, 3000)
    hb.start(ws, onDead)

    jest.advanceTimersByTime(10000) // 10 unanswered-proof pings

    expect(ws.ping).toHaveBeenCalled()
    expect(onDead).not.toHaveBeenCalled()
    hb.stop()
  })

  it('stop() clears every timer so the process can exit', () => {
    const ws = new FakeSocket()
    const hb = new WebSocketHeartbeat(1000, 3000)
    hb.start(ws, jest.fn())
    jest.advanceTimersByTime(1500) // ping sent, pong deadline armed
    hb.stop()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('stops on socket close', () => {
    const ws = new FakeSocket()
    const hb = new WebSocketHeartbeat(1000, 3000)
    hb.start(ws, jest.fn())
    ws.emit('close')
    jest.advanceTimersByTime(10000)
    expect(ws.ping).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })
})
