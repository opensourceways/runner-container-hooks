import * as k8s from '@kubernetes/client-node'
import { isAuthPermissionsOK, requiredPermissions } from '../src/k8s'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn()
}))

interface SarRequest {
  body: {
    spec: {
      resourceAttributes: {
        verb: string
        resource: string
        subresource?: string
      }
    }
  }
}

function sarAttrs(req: SarRequest) {
  return req.body.spec.resourceAttributes
}

const totalSars = requiredPermissions.reduce(
  (sum, r) => sum + r.verbs.length,
  0
)

describe('isAuthPermissionsOK', () => {
  let sarSpy: jest.SpyInstance

  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'default'
    sarSpy = jest
      .spyOn(k8s.AuthorizationV1Api.prototype, 'createSelfSubjectAccessReview')
      .mockImplementation(
        async () =>
          ({ status: { allowed: true } }) as k8s.V1SelfSubjectAccessReview
      )
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('submits a fresh SAR body per request (no shared mutable instance)', async () => {
    await expect(isAuthPermissionsOK()).resolves.toBe(true)
    expect(sarSpy).toHaveBeenCalledTimes(totalSars)
    // With the old single shared SAR object, every call would serialize the
    // verb/resource of whichever loop iteration ran last; distinct per-call
    // payloads prove the per-request instance fix.
    const combos = sarSpy.mock.calls.map(call => {
      const attrs = sarAttrs(call[0] as SarRequest)
      return `${attrs.resource}/${attrs.subresource || ''}:${attrs.verb}`
    })
    expect(new Set(combos).size).toBe(totalSars)
  })

  it('rides through a transient 403 on one SAR without failing', async () => {
    // A warming-up apiserver replica answers the first request with a
    // forbidden that succeeds immediately on retry.
    sarSpy
      .mockRejectedValueOnce({
        code: 403,
        message: 'selfsubjectaccessreviews.authorization.k8s.io is forbidden'
      })
      .mockImplementation(
        async () =>
          ({ status: { allowed: true } }) as k8s.V1SelfSubjectAccessReview
      )
    await expect(isAuthPermissionsOK()).resolves.toBe(true)
    expect(sarSpy).toHaveBeenCalledTimes(totalSars + 1)
  })

  it('returns false when the token genuinely lacks a permission', async () => {
    // allowed:false is a successful API call, not a transient error: it must
    // not be retried, and the preflight must report the denial.
    sarSpy.mockImplementation(
      async (req: SarRequest) =>
        ({
          status: { allowed: sarAttrs(req).verb !== 'watch' }
        }) as k8s.V1SelfSubjectAccessReview
    )
    await expect(isAuthPermissionsOK()).resolves.toBe(false)
    expect(sarSpy).toHaveBeenCalledTimes(totalSars)
  })

  it('fails fast on deterministic API errors (400)', async () => {
    sarSpy.mockRejectedValue({
      code: 400,
      message: 'invalid selfsubjectaccessreview body'
    })
    await expect(isAuthPermissionsOK()).rejects.toMatchObject({ code: 400 })
    expect(sarSpy).toHaveBeenCalledTimes(totalSars)
  })
})
