import * as k8s from '@kubernetes/client-node'
import { prunePods, pruneSecrets } from '../src/k8s'
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

  it('does not retry a definitive pod deletion error', async () => {
    const listNamespacedPod = jest
      .fn()
      .mockResolvedValue({ items: [{ metadata: { name: 'job-pod' } }] })
    const deleteNamespacedPod = jest.fn().mockRejectedValue({ code: 404 })

    await expect(
      prunePods(fakeApi({ listNamespacedPod, deleteNamespacedPod }), fastRetry)
    ).rejects.toEqual({ code: 404 })

    expect(deleteNamespacedPod).toHaveBeenCalledTimes(1)
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
