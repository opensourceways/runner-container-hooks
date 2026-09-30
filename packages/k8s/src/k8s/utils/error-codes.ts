export const ERROR_CODES = {
  NPU_8020: 'ARC-NPU-8020',
  SCHED_001: 'ARC-SCHED-001',
  SCHED_002: 'ARC-SCHED-002',
  SCHED_003: 'ARC-SCHED-003',
  IMG_001: 'ARC-IMG-001',
  IMG_002: 'ARC-IMG-002',
  IMG_003: 'ARC-IMG-003',
  VOL_001: 'ARC-VOL-001',
  VOL_002: 'ARC-VOL-002',
  RUNTIME_001: 'ARC-RUNTIME-001',
  RUNTIME_002: 'ARC-RUNTIME-002'
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export function formatErrorCode(code: ErrorCode): string {
  return `[${code}]`
}
