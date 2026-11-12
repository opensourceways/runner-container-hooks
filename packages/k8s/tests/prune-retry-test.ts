import * as k8s from '@kubernetes/client-node'
import {
  createJobPod,
  createSecretForEnvs,
  prunePods,
  pruneSecrets
} from '../src/k8s'
import { RetryK8sApiCallOptions } from '../src/k8s/utils'

// Keep retries deterministic and fast: the default backoff is seconds long.
const fastRetry: RetryK8sApiCallOptions = {
  attempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2,
  timeoutMs: 50
}

function fakeApi(overrides: Record<string, unknown>): k8s.CoreV1Api {
  return overrides as unknown as k8s.CoreV1Api
}

describe('cleanup API retries', () => {
  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'test-ns'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'test-runner-pod'
  })

  it('retries a transient failure when listing pods', async () => {
    const listNamespacedPod = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
      .mockResolvedValueOnce({ items: [] })

    await prunePods(fakeApi({ listNamespacedPod }), fastRetry)

    expect(listNamespacedPod).toHaveBeenCalledTimes(2)
  })

  it('retries a transient failure when deleting a pod', async () => {
    const listNamespacedPod = jest
      .fn()
      .mockResolvedValue({ items: [{ metadata: { name: 'job-pod' } }] })
    const deleteNamespacedPod = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockResolvedValueOnce({})

    await prunePods(
      fakeApi({ listNamespacedPod, deleteNamespacedPod }),
      fastRetry
    )

    expect(deleteNamespacedPod).toHaveBeenCalledTimes(2)
    expect(deleteNamespacedPod).toHaveBeenLastCalledWith({
      name: 'job-pod',
      namespace: 'test-ns',
      gracePeriodSeconds: 0
    })
  })

  it('treats a 404 as already deleted instead of failing the cleanup', async () => {
    const listNamespacedPod = jest
      .fn()
      .mockResolvedValue({ items: [{ metadata: { name: 'job-pod' } }] })
    const deleteNamespacedPod = jest.fn().mockRejectedValue({ code: 404 })

    await expect(
      prunePods(fakeApi({ listNamespacedPod, deleteNamespacedPod }), fastRetry)
    ).resolves.toBeUndefined()

    expect(deleteNamespacedPod).toHaveBeenCalledTimes(1)
  })

  it('still fails on a non-retryable, non-404 delete error', async () => {
    const listNamespacedPod = jest
      .fn()
      .mockResolvedValue({ items: [{ metadata: { name: 'job-pod' } }] })
    const deleteNamespacedPod = jest.fn().mockRejectedValue({ code: 400 })

    await expect(
      prunePods(fakeApi({ listNamespacedPod, deleteNamespacedPod }), fastRetry)
    ).rejects.toEqual({ code: 400 })

    expect(deleteNamespacedPod).toHaveBeenCalledTimes(1)
  })

  it('treats a 404 after a dropped connection as success', async () => {
    const listNamespacedSecret = jest
      .fn()
      .mockResolvedValue({ items: [{ metadata: { name: 'job-secret' } }] })
    const deleteNamespacedSecret = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
      .mockRejectedValueOnce({ code: 404 })

    await expect(
      pruneSecrets(
        fakeApi({ listNamespacedSecret, deleteNamespacedSecret }),
        fastRetry
      )
    ).resolves.toBeUndefined()

    expect(deleteNamespacedSecret).toHaveBeenCalledTimes(2)
  })

  it('abandons a hung request and retries with a fresh connection', async () => {
    const listNamespacedPod = jest
      .fn()
      .mockImplementationOnce(async () => new Promise(() => {}))
      .mockResolvedValueOnce({ items: [] })

    await prunePods(fakeApi({ listNamespacedPod }), fastRetry)

    expect(listNamespacedPod).toHaveBeenCalledTimes(2)
  })

  it('retries secret listing and deletion', async () => {
    const listNamespacedSecret = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
      .mockResolvedValueOnce({ items: [{ metadata: { name: 'job-secret' } }] })
    const deleteNamespacedSecret = jest
      .fn()
      .mockRejectedValueOnce({ code: 503 })
      .mockResolvedValueOnce({})

    await pruneSecrets(
      fakeApi({ listNamespacedSecret, deleteNamespacedSecret }),
      fastRetry
    )

    expect(listNamespacedSecret).toHaveBeenCalledTimes(2)
    expect(deleteNamespacedSecret).toHaveBeenCalledTimes(2)
    expect(deleteNamespacedSecret).toHaveBeenLastCalledWith({
      name: 'job-secret',
      namespace: 'test-ns'
    })
  })
})

describe('create API retries', () => {
  beforeEach(() => {
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'test-ns'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'test-runner-pod'
  })

  it('retries a transient failure when creating a job pod', async () => {
    const created = { metadata: { name: 'job-pod' } }
    const createNamespacedPod = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
      .mockResolvedValueOnce(created)

    const pod = await createJobPod(
      'job-pod',
      undefined,
      undefined,
      undefined,
      undefined,
      fakeApi({ createNamespacedPod }),
      fastRetry
    )

    expect(createNamespacedPod).toHaveBeenCalledTimes(2)
    expect(pod).toBe(created)
  })

  it('reads the pod back when a retried create reports AlreadyExists', async () => {
    const existing = { metadata: { name: 'job-pod' } }
    const createNamespacedPod = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
      .mockRejectedValueOnce({ code: 409 })
    const readNamespacedPod = jest.fn().mockResolvedValue(existing)

    const pod = await createJobPod(
      'job-pod',
      undefined,
      undefined,
      undefined,
      undefined,
      fakeApi({ createNamespacedPod, readNamespacedPod }),
      fastRetry
    )

    expect(createNamespacedPod).toHaveBeenCalledTimes(2)
    expect(readNamespacedPod).toHaveBeenCalledWith({
      name: 'job-pod',
      namespace: 'test-ns'
    })
    expect(pod).toBe(existing)
  })

  it('does not swallow a non-AlreadyExists create error', async () => {
    const createNamespacedPod = jest.fn().mockRejectedValue({ code: 422 })
    const readNamespacedPod = jest.fn()

    await expect(
      createJobPod(
        'job-pod',
        undefined,
        undefined,
        undefined,
        undefined,
        fakeApi({ createNamespacedPod, readNamespacedPod }),
        fastRetry
      )
    ).rejects.toEqual({ code: 422 })

    expect(readNamespacedPod).not.toHaveBeenCalled()
  })

  it('retries a transient failure when creating a secret', async () => {
    const createNamespacedSecret = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockResolvedValueOnce({})

    await createSecretForEnvs(
      { FOO: 'bar' },
      fakeApi({ createNamespacedSecret }),
      fastRetry
    )

    expect(createNamespacedSecret).toHaveBeenCalledTimes(2)
  })

  it('reads the secret back when a retried create reports AlreadyExists', async () => {
    const createNamespacedSecret = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
      .mockRejectedValueOnce({ code: 409 })
    const readNamespacedSecret = jest.fn().mockResolvedValue({})

    await createSecretForEnvs(
      { FOO: 'bar' },
      fakeApi({ createNamespacedSecret, readNamespacedSecret }),
      fastRetry
    )

    expect(createNamespacedSecret).toHaveBeenCalledTimes(2)
    expect(readNamespacedSecret).toHaveBeenCalledTimes(1)
  })
})
