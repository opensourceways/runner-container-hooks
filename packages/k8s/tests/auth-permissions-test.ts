import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { isAuthPermissionsOK, requiredPermissions } from '../src/k8s'

const totalReviews = requiredPermissions.reduce(
  (sum, p) => sum + p.verbs.length,
  0
)

// fast, deterministic retry budget for tests
const fastRetry = {
  attempts: 2,
  baseDelayMs: 1,
  maxDelayMs: 2,
  timeoutMs: 5000,
  jitter: false
}

const allowed = async () => ({ status: { allowed: true } })
const refused = async () => {
  throw new Error('connect ECONNREFUSED 10.247.0.1:443')
}

describe('isAuthPermissionsOK', () => {
  const ns = 'ci-runners'
  let tmpDir: string

  beforeAll(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = ns
  })

  const cacheFile = () =>
    path.join(tmpDir, 'container-hooks-k8s-auth-cache.json')

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cache-'))
    process.env['RUNNER_TEMP'] = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['RUNNER_TEMP']
  })

  it('passes and writes the per-job cache when every review is allowed', async () => {
    const review = jest.fn(allowed)
    await expect(
      isAuthPermissionsOK({ review, retryOptions: fastRetry })
    ).resolves.toBe(true)
    expect(review).toHaveBeenCalledTimes(totalReviews)
    expect(JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))).toMatchObject({
      namespace: ns,
      allowed: true
    })
  })

  it('answers from the cache on later hook invocations without API calls', async () => {
    await isAuthPermissionsOK({
      review: jest.fn(allowed),
      retryOptions: fastRetry
    })
    const spy = jest.fn(allowed)
    await expect(
      isAuthPermissionsOK({ review: spy, retryOptions: fastRetry })
    ).resolves.toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns false (not throwing) on a definitive allowed:false answer and caches nothing', async () => {
    const review = jest.fn(async (attrs: { verb: string }) =>
      Promise.resolve({ status: { allowed: attrs.verb !== 'delete' } })
    )
    await expect(
      isAuthPermissionsOK({ review, retryOptions: fastRetry })
    ).resolves.toBe(false)
    expect(fs.existsSync(cacheFile())).toBe(false)
  })

  it('survives a control-plane stall when reviews recover mid-check', async () => {
    let failures = 0
    const review = jest.fn(async () => {
      if (failures++ < 12) {
        throw new Error('connect ECONNREFUSED 10.247.0.1:443')
      }
      return allowed()
    })
    await expect(
      isAuthPermissionsOK({
        review,
        retryOptions: { ...fastRetry, attempts: 5 }
      })
    ).resolves.toBe(true)
  })

  it('throws a NOT-a-denial error when reviews stay undeliverable and no cache exists', async () => {
    const review = jest.fn(refused)
    await expect(
      isAuthPermissionsOK({ review, retryOptions: fastRetry })
    ).rejects.toThrow(/NOT a permissions denial/)
  })

  it('degrades to the cached verdict during an outage instead of killing the hook', async () => {
    // Seed a cache entry past the 1h TTL but inside the 24h grace window.
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({
        namespace: ns,
        allowed: true,
        timestamp: Date.now() - 2 * 60 * 60 * 1000
      })
    )
    const review = jest.fn(refused)
    await expect(
      isAuthPermissionsOK({ review, retryOptions: fastRetry })
    ).resolves.toBe(true)
  })

  it('does not reuse a cache entry written under another namespace', async () => {
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({
        namespace: 'someone-elses-runners',
        allowed: true,
        timestamp: Date.now()
      })
    )
    await expect(
      isAuthPermissionsOK({ review: refused, retryOptions: fastRetry })
    ).rejects.toThrow(/NOT a permissions denial/)
  })

  it('propagates non-retryable API errors unchanged', async () => {
    const review = jest.fn(() => {
      throw { code: 400, message: 'bad request' }
    })
    await expect(
      isAuthPermissionsOK({ review, retryOptions: fastRetry })
    ).rejects.toMatchObject({ code: 400 })
  })

  it('sends a fresh review body per probe and per retry (no shared mutable SAR)', async () => {
    const seen: string[] = []
    let first = true
    const review = jest.fn(
      async (attrs: {
        resource: string
        verb: string
        subresource: string
      }) => {
        seen.push(`${attrs.resource}/${attrs.subresource}:${attrs.verb}`)
        if (first) {
          first = false
          throw new Error('connect ECONNREFUSED 10.247.0.1:443')
        }
        return allowed()
      }
    )
    await expect(
      isAuthPermissionsOK({
        review,
        retryOptions: { ...fastRetry, attempts: 3 }
      })
    ).resolves.toBe(true)
    // The retried probe must re-submit its own verb, not whichever the loop
    // reached last — every attribute set appears, retries included.
    const unique = new Set(seen)
    expect(unique.size).toBe(totalReviews)
    expect(seen.length).toBeGreaterThan(totalReviews)
  })
})
