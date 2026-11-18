import * as core from '@actions/core'

// Minimal surface of a Kubernetes exec WebSocket that the heartbeat needs.
// `@kubernetes/client-node` returns an `isomorphic-ws` socket which, on Node,
// is a real `ws.WebSocket` (EventEmitter) exposing ping()/close()/on(). The
// interface is intentionally structural so unit tests can pass an EventEmitter
// double and so a socket without ping support degrades to a no-op.
export interface HeartbeatWebSocket {
  readyState: number
  ping(): void
  close(): void
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
}

export function parsePositiveMsEnv(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export class WebSocketHeartbeat {
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private pongTimeout: ReturnType<typeof setTimeout> | null = null
  private lastHeartbeatLog = 0
  private static readonly LOG_INTERVAL_MS = 2 * 60 * 1000

  constructor(
    private readonly pingPeriodMs: number,
    private readonly pongDeadlineMs: number
  ) {}

  private shouldLog(): boolean {
    const now = Date.now()
    if (now - this.lastHeartbeatLog >= WebSocketHeartbeat.LOG_INTERVAL_MS) {
      this.lastHeartbeatLog = now
      return true
    }
    return false
  }

  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout)
      this.pongTimeout = null
    }
  }

  start(ws: HeartbeatWebSocket, onDead: (err: Error) => void): void {
    core.debug(
      `[Heartbeat] Starting with period=${this.pingPeriodMs}ms, deadline=${this.pongDeadlineMs}ms`
    )
    this.lastHeartbeatLog = Date.now()

    const resetPongTimeout = (): void => {
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout)
        this.pongTimeout = null
      }
      this.pongTimeout = setTimeout(() => {
        core.warning(
          `[Heartbeat] No pong received in ${this.pongDeadlineMs}ms, closing stale connection`
        )
        this.stop()
        try {
          ws.close()
        } catch {
          // ignore errors closing an already-closing socket
        }
        onDead(
          new Error(
            `WebSocket heartbeat timeout: no pong within ${this.pongDeadlineMs}ms`
          )
        )
      }, this.pongDeadlineMs)
    }

    // Arm the deadline only after the first ping is sent, not immediately on
    // start, so a slow CONNECTING socket cannot time out before any exchange.
    let deadlineArmed = false

    ws.on('pong', () => {
      if (this.shouldLog()) {
        core.debug('[Heartbeat] Pong received')
      }
      if (deadlineArmed) {
        resetPongTimeout()
      }
    })

    ws.on('error', (err: Error) => {
      core.error(`[Heartbeat] WebSocket error: ${err?.message ?? String(err)}`)
      this.stop()
    })

    ws.on('close', () => {
      core.debug('[Heartbeat] WebSocket closed, stopping heartbeat')
      this.stop()
    })

    // WebSocket readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
    this.pingInterval = setInterval(() => {
      if (ws.readyState === 0) {
        // Still connecting — skip this tick but keep the interval alive
        return
      }
      if (ws.readyState === 1) {
        try {
          ws.ping()
          if (!deadlineArmed) {
            deadlineArmed = true
            resetPongTimeout()
          }
          if (this.shouldLog()) {
            core.debug('[Heartbeat] Ping sent')
          }
        } catch (err) {
          core.error(`[Heartbeat] Ping failed: ${err}`)
          this.stop()
        }
      } else {
        // CLOSING (2) or CLOSED (3)
        this.stop()
      }
    }, this.pingPeriodMs)
  }
}
