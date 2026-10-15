import { isRetryableK8sApiError, retryK8sApiCall } from '../src/k8s/utils'

describe('isRetryableK8sApiError', () => {
  it('treats transient HTTP statuses as retryable', () => {
    // ApiException thrown by @kubernetes/client-node carries a numeric `code`
    expect(isRetryableK8sApiError({ code: 403 })).toBe(true)
    expect(isRetryableK8sApiError({ code: 401 })).toBe(true)
    expect(isRetryableK8sApiError({ code: 429 })).toBe(true)
    expect(isRetryableK8sApiError({ code: 500 })).toBe(true)
    expect(isRetryableK8sApiError({ code: 503 })).toBe(true)
  })

  it('treats non-transient HTTP statuses as fatal', () => {
    expect(isRetryableK8sApiError({ code: 400 })).toBe(false)
    expect(isRetryableK8sApiError({ code: 404 })).toBe(false)
    expect(isRetryableK8sApiError({ code: 409 })).toBe(false)
  })

  it('treats connection-level fetch failures as retryable', () => {
    // FetchError from node-fetch carries a system error `code`
    expect(isRetryableK8sApiError({ code: 'ECONNREFUSED' })).toBe(true)
    expect(isRetryableK8sApiError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableK8sApiError({ code: 'ETIMEDOUT' })).toBe(true)
    // undici-style wrapped causes
    expect(
      isRetryableK8sApiError({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
    ).toBe(true)
  })

  it('falls back to the error message', () => {
    expect(
      isRetryableK8sApiError(
        new Error(
          'request to https://10.247.0.1/apis/authorization.k8s.io/v1/selfsubjectaccessreviews failed, reason: connect ECONNREFUSED 10.247.0.1:443'
        )
      )
    ).toBe(true)
    expect(isRetryableK8sApiError(new Error('plain bug'))).toBe(false)
    expect(isRetryableK8sApiError(undefined)).toBe(false)
    expect(isRetryableK8sApiError('ECONNREFUSED')).toBe(false)
  })
})

describe('retryK8sApiCall', () => {
  const fast = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 }

  it('returns the first successful result without retrying', async () => {
    const op = jest.fn().mockResolvedValue('ok')
    await expect(retryK8sApiCall(op, 'test', fast)).resolves.toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('rides through transient failures and succeeds', async () => {
    const op = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ECONNREFUSED' })
      .mockRejectedValueOnce({ code: 403 })
      .mockResolvedValue('recovered')
    await expect(retryK8sApiCall(op, 'test', fast)).resolves.toBe('recovered')
    expect(op).toHaveBeenCalledTimes(3)
  })

  it('does not retry fatal (non-transient) errors', async () => {
    const op = jest
      .fn()
      .mockRejectedValue({ code: 400, message: 'bad request' })
    await expect(retryK8sApiCall(op, 'test', fast)).rejects.toMatchObject({
      code: 400
    })
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('throws the last error once attempts are exhausted', async () => {
    const op = jest.fn().mockRejectedValue({ code: 503 })
    await expect(
      retryK8sApiCall(op, 'test', { ...fast, attempts: 2 })
    ).rejects.toMatchObject({ code: 503 })
    expect(op).toHaveBeenCalledTimes(2)
  })

  it('abandons a hung request via timeout and retries', async () => {
    const neverResolves = new Promise<string>(() => undefined)
    const op = jest
      .fn()
      .mockReturnValueOnce(neverResolves)
      .mockResolvedValueOnce('late-success')
    await expect(
      retryK8sApiCall(op, 'test', {
        attempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 2,
        timeoutMs: 20
      })
    ).resolves.toBe('late-success')
    expect(op).toHaveBeenCalledTimes(2)
  })
})
