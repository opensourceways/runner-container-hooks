import * as core from '@actions/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Per-job cache for the ServiceAccount permission preflight.
 *
 * Each hook invocation (PrepareJob, every step, CleanupJob) is a FRESH
 * `node index.js` process, so the cache has to live on disk. RUNNER_TEMP is
 * the natural home: it is shared by all invocations of one job and disappears
 * with the job's pod, so a cached verdict can never leak across jobs (and a
 * mid-job RBAC change is, as in #64, explicitly out of scope — the real pod
 * calls still enforce RBAC).
 *
 * Why this exists: without the cache every step pays 15 SelfSubjectAccessReview
 * POSTs (~1.5k/min observed during a nightly fan-out on shared infra) and, more
 * importantly, every step is one API-server stall away from being killed by the
 * preflight. With the cache only the first hook call of a job touches the API
 * server, and a later stall can degrade to this recent successful verdict.
 */

export const AUTH_CACHE_TTL_MS = 60 * 60 * 1000 // 1 h
const STALE_GRACE_MS = 24 * 60 * 60 * 1000 // reusable past TTL when undeterminable

export interface AuthCacheEntry {
  namespace: string
  allowed: boolean
  timestamp: number
}

function cacheFilePath(): string {
  const dir = process.env['RUNNER_TEMP'] || os.tmpdir()
  return path.join(dir, 'container-hooks-k8s-auth-cache.json')
}

export function readAuthCache(): AuthCacheEntry | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(cacheFilePath(), 'utf8')
    ) as AuthCacheEntry
    if (
      parsed &&
      typeof parsed.allowed === 'boolean' &&
      typeof parsed.timestamp === 'number' &&
      typeof parsed.namespace === 'string'
    ) {
      return parsed
    }
  } catch {
    // absence or a corrupt cache is not an error
  }
  return undefined
}

export function writeAuthCache(entry: AuthCacheEntry): void {
  try {
    fs.mkdirSync(path.dirname(cacheFilePath()), { recursive: true })
    fs.writeFileSync(cacheFilePath(), JSON.stringify(entry))
  } catch (err) {
    core.debug(`could not persist auth cache: ${String(err)}`)
  }
}

/** True when the cached verdict is fresh enough to skip the API check. */
export function isFreshAuthCache(
  entry: AuthCacheEntry | undefined,
  namespace: string,
  now: number
): boolean {
  return (
    !!entry &&
    entry.allowed &&
    entry.namespace === namespace &&
    now - entry.timestamp < AUTH_CACHE_TTL_MS
  )
}

/**
 * True when the API could not be reached and the cached verdict is recent
 * enough to ride out the outage with a warning instead of killing the step.
 */
export function isStaleAuthCacheUsable(
  entry: AuthCacheEntry | undefined,
  namespace: string,
  now: number
): boolean {
  return (
    !!entry &&
    entry.allowed &&
    entry.namespace === namespace &&
    now - entry.timestamp < AUTH_CACHE_TTL_MS + STALE_GRACE_MS
  )
}
