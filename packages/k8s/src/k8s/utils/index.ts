import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import * as core from '@actions/core'
import { v1 as uuidv4 } from 'uuid'
import { CONTAINER_EXTENSION_PREFIX } from '../../hooks/constants'
import * as shlex from 'shlex'
import { Mount } from 'hooklib'

export const DEFAULT_CONTAINER_ENTRY_POINT_ARGS = [`-f`, `/dev/null`]
export const DEFAULT_CONTAINER_ENTRY_POINT = 'tail'

export const ENV_HOOK_TEMPLATE_PATH = 'ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE'
export const ENV_USE_KUBE_SCHEDULER = 'ACTIONS_RUNNER_USE_KUBE_SCHEDULER'

export const EXTERNALS_VOLUME_NAME = 'externals'
export const GITHUB_VOLUME_NAME = 'github'
export const WORK_VOLUME = 'work'

export const CONTAINER_VOLUMES: k8s.V1VolumeMount[] = [
  {
    name: EXTERNALS_VOLUME_NAME,
    mountPath: '/__e'
  },
  {
    name: WORK_VOLUME,
    mountPath: '/__w'
  },
  {
    name: GITHUB_VOLUME_NAME,
    mountPath: '/github'
  }
]

export function prepareJobScript(userVolumeMounts: Mount[]): {
  containerPath: string
  runnerPath: string
} {
  let mountDirs = userVolumeMounts.map(m => m.targetVolumePath).join(' ')

  const content = `#!/bin/sh -l
set -e
cp -R /__w/_temp/_github_home /github/home
cp -R /__w/_temp/_github_workflow /github/workflow
mkdir -p ${mountDirs}
`

  const filename = `${uuidv4()}.sh`
  const entryPointPath = `${process.env.RUNNER_TEMP}/${filename}`
  fs.writeFileSync(entryPointPath, content)
  return {
    containerPath: `/__w/_temp/${filename}`,
    runnerPath: entryPointPath
  }
}

export function writeRunScript(
  workingDirectory: string,
  entryPoint: string,
  entryPointArgs?: string[],
  prependPath?: string[],
  environmentVariables?: { [key: string]: string }
): { containerPath: string; runnerPath: string } {
  let exportPath = ''
  if (prependPath?.length) {
    // TODO: remove compatibility with typeof prependPath === 'string' as we bump to next major version, the hooks will lose PrependPath compat with runners 2.293.0 and older
    const prepend =
      typeof prependPath === 'string' ? prependPath : prependPath.join(':')
    exportPath = `export PATH=${prepend}:$PATH`
  }

  let environmentPrefix = scriptEnv(environmentVariables)

  const content = `#!/bin/sh -l
set -e
rm "$0" # remove script after running
${exportPath}
cd ${workingDirectory} && \
exec ${environmentPrefix} ${entryPoint} ${
    entryPointArgs?.length ? entryPointArgs.join(' ') : ''
  }
`
  const filename = `${uuidv4()}.sh`
  const entryPointPath = `${process.env.RUNNER_TEMP}/${filename}`
  fs.writeFileSync(entryPointPath, content)
  return {
    containerPath: `/__w/_temp/${filename}`,
    runnerPath: entryPointPath
  }
}

export function writeContainerStepScript(
  dst: string,
  workingDirectory: string,
  entryPoint: string,
  entryPointArgs?: string[],
  environmentVariables?: { [key: string]: string }
): { containerPath: string; runnerPath: string } {
  let environmentPrefix = scriptEnv(environmentVariables)

  const parts = workingDirectory.split('/').slice(-2)
  if (parts.length !== 2) {
    throw new Error(`Invalid working directory: ${workingDirectory}`)
  }

  const content = `#!/bin/sh -l
rm "$0" # remove script after running
mv /__w/_temp/_github_home /github/home && \
mv /__w/_temp/_github_workflow /github/workflow && \
mv /__w/_temp/_runner_file_commands /github/file_commands || true && \
mv /__w/${parts.join('/')}/ /github/workspace && \
cd /github/workspace && \
exec ${environmentPrefix} ${entryPoint} ${
    entryPointArgs?.length ? entryPointArgs.join(' ') : ''
  }
`
  const filename = `${uuidv4()}.sh`
  const entryPointPath = `${dst}/${filename}`
  core.debug(`Writing container step script to ${entryPointPath}`)
  fs.writeFileSync(entryPointPath, content)
  return {
    containerPath: `/__w/_temp/${filename}`,
    runnerPath: entryPointPath
  }
}

function scriptEnv(envs?: { [key: string]: string }): string {
  if (!envs || !Object.entries(envs).length) {
    return ''
  }
  const envBuffer: string[] = []
  for (const [key, value] of Object.entries(envs)) {
    if (
      key.includes(`=`) ||
      key.includes(`'`) ||
      key.includes(`"`) ||
      key.includes(`$`)
    ) {
      throw new Error(
        `environment key ${key} is invalid - the key must not contain =, $, ', or "`
      )
    }
    envBuffer.push(
      `"${key}=${value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`')}"`
    )
  }

  if (!envBuffer?.length) {
    return ''
  }

  return `env ${envBuffer.join(' ')} `
}

export function generateContainerName(image: string): string {
  const nameWithTag = image.split('/').pop()
  const name = nameWithTag?.split(':')[0]

  if (!name) {
    throw new Error(`Image definition '${image}' is invalid`)
  }

  return name
}

// Overwrite or append based on container options
//
// Keep in mind, envs and volumes could be passed as fields in container definition
// so default volume mounts and envs are appended first, and then create options are used
// to append more values
//
// Rest of the fields are just applied
// For example, container.createOptions.container.image is going to overwrite container.image field
export function mergeContainerWithOptions(
  base: k8s.V1Container,
  from: k8s.V1Container
): void {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'name') {
      if (value !== CONTAINER_EXTENSION_PREFIX + base.name) {
        core.warning("Skipping name override: name can't be overwritten")
      }
      continue
    } else if (key === 'image') {
      core.warning("Skipping image override: image can't be overwritten")
      continue
    } else if (key === 'env') {
      const envs = value as k8s.V1EnvVar[]
      base.env = mergeLists(base.env, envs)
    } else if (key === 'volumeMounts' && value) {
      const volumeMounts = value as k8s.V1VolumeMount[]
      base.volumeMounts = mergeLists(base.volumeMounts, volumeMounts)
    } else if (key === 'ports' && value) {
      const ports = value as k8s.V1ContainerPort[]
      base.ports = mergeLists(base.ports, ports)
    } else {
      base[key] = value
    }
  }
}

export function mergePodSpecWithOptions(
  base: k8s.V1PodSpec,
  from: k8s.V1PodSpec
): void {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'containers') {
      base.containers.push(
        ...from.containers.filter(
          e => !e.name?.startsWith(CONTAINER_EXTENSION_PREFIX)
        )
      )
    } else if (key === 'volumes' && value) {
      const volumes = value as k8s.V1Volume[]
      base.volumes = mergeLists(base.volumes, volumes)
    } else {
      base[key] = value
    }
  }
}

export function mergeObjectMeta(
  base: { metadata?: k8s.V1ObjectMeta },
  from: k8s.V1ObjectMeta
): void {
  if (!base.metadata?.labels || !base.metadata?.annotations) {
    throw new Error(
      "Can't merge metadata: base.metadata or base.annotations field is undefined"
    )
  }
  if (from?.labels) {
    for (const [key, value] of Object.entries(from.labels)) {
      if (base.metadata?.labels?.[key]) {
        core.warning(`Label ${key} is already defined and will be overwritten`)
      }
      base.metadata.labels[key] = value
    }
  }

  if (from?.annotations) {
    for (const [key, value] of Object.entries(from.annotations)) {
      if (base.metadata?.annotations?.[key]) {
        core.warning(
          `Annotation ${key} is already defined and will be overwritten`
        )
      }
      base.metadata.annotations[key] = value
    }
  }
}

export function readExtensionFromFile(): k8s.V1PodTemplateSpec | undefined {
  const filePath = process.env[ENV_HOOK_TEMPLATE_PATH]
  if (!filePath) {
    return undefined
  }
  const doc = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!doc || typeof doc !== 'object') {
    throw new Error(`Failed to parse ${filePath}`)
  }
  return doc as k8s.V1PodTemplateSpec
}

export function useKubeScheduler(): boolean {
  return process.env[ENV_USE_KUBE_SCHEDULER] === 'true'
}

export enum PodPhase {
  PENDING = 'Pending',
  RUNNING = 'Running',
  SUCCEEDED = 'Succeeded',
  FAILED = 'Failed',
  UNKNOWN = 'Unknown',
  COMPLETED = 'Completed'
}

function mergeLists<T>(base?: T[], from?: T[]): T[] {
  const b: T[] = base || []
  if (!from?.length) {
    return b
  }
  b.push(...from)
  return b
}

export function fixArgs(args: string[]): string[] {
  return shlex.split(args.join(' '))
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function listDirAllCommand(dir: string): string {
  return `cd ${shlex.quote(dir)} && find . -type f -not -path '*/_runner_hook_responses*' -exec stat -c '%s %n' {} \\;`
}

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET'
])

const RETRYABLE_MESSAGE_PATTERN =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network timeout|timed out after/i

// Transient HTTP statuses worth retrying:
// - 401/403: an apiserver replica may briefly answer before its
//   auth/RBAC caches are warm (observed on self-hosted k8s runners as
//   "selfsubjectaccessreviews ... is forbidden" that succeeds on retry)
// - 408/429/5xx: classic transient server-side conditions
const RETRYABLE_HTTP_STATUS_CODES = new Set([
  401, 403, 408, 429, 500, 502, 503, 504
])

export function isRetryableK8sApiError(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== 'object') {
    return false
  }
  const e = err as {
    code?: unknown
    cause?: { code?: unknown }
    message?: unknown
  }
  if (typeof e.code === 'number') {
    return RETRYABLE_HTTP_STATUS_CODES.has(e.code)
  }
  if (typeof e.code === 'string' && RETRYABLE_NETWORK_ERROR_CODES.has(e.code)) {
    return true
  }
  if (e.cause && typeof e.cause.code === 'string') {
    return RETRYABLE_NETWORK_ERROR_CODES.has(e.cause.code)
  }
  const message = typeof e.message === 'string' ? e.message : String(err)
  return RETRYABLE_MESSAGE_PATTERN.test(message)
}

export interface RetryK8sApiCallOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  description: string
): Promise<T> {
  if (!timeoutMs) {
    return promise
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        Object.assign(
          new Error(
            `k8s API call "${description}" timed out after ${timeoutMs} ms`
          ),
          {
            code: 'ETIMEDOUT'
          }
        )
      )
    }, timeoutMs)
    promise
      .then(value => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(err => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

/**
 * Executes a Kubernetes API call with bounded retries and exponential backoff
 * on transient failures (connection refused/reset/hang, or a momentary
 * auth/RBAC 401/403 from a warming-up apiserver replica).
 *
 * The kubelet-to-apiserver ClusterIP path on self-hosted runner nodes opens
 * sub-second windows whenever managed control-plane endpoints rotate; a single
 * untimed request hitting such a window used to abort the whole workflow step.
 * Retrying a handful of times rides through the window instead of failing.
 */
export async function retryK8sApiCall<T>(
  operation: () => Promise<T>,
  description: string,
  options: RetryK8sApiCallOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 4
  const baseDelayMs = options.baseDelayMs ?? 3000
  const maxDelayMs = options.maxDelayMs ?? 15000
  const timeoutMs = options.timeoutMs ?? 15000

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(operation(), timeoutMs, description)
    } catch (err) {
      lastError = err
      if (attempt === attempts || !isRetryableK8sApiError(err)) {
        throw err
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      core.warning(
        `k8s API call "${description}" failed on attempt ${attempt}/${attempts}: ${
          err instanceof Error ? err.message : String(err)
        }. Retrying in ${delayMs} ms.`
      )
      await sleep(delayMs)
    }
  }
  throw lastError
}
