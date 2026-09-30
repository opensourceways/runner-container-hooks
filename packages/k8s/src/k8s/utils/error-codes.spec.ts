import { describe, it, expect } from 'vitest'
import { ERROR_CODES, formatErrorCode } from './error-codes'

describe('error-codes constants', () => {
  it('defines ARC-NPU-8020 for NPU init failure', () => {
    expect(ERROR_CODES.NPU_8020).toBe('ARC-NPU-8020')
  })

  it('defines ARC-SCHED-001 for runs-on label mismatch', () => {
    expect(ERROR_CODES.SCHED_001).toBe('ARC-SCHED-001')
  })

  it('defines ARC-SCHED-002 for NPU resource shortage', () => {
    expect(ERROR_CODES.SCHED_002).toBe('ARC-SCHED-002')
  })

  it('defines ARC-SCHED-003 for untolerated taint', () => {
    expect(ERROR_CODES.SCHED_003).toBe('ARC-SCHED-003')
  })

  it('defines ARC-IMG-001 for ImagePullBackOff', () => {
    expect(ERROR_CODES.IMG_001).toBe('ARC-IMG-001')
  })

  it('defines ARC-IMG-002 for InvalidImageName', () => {
    expect(ERROR_CODES.IMG_002).toBe('ARC-IMG-002')
  })

  it('defines ARC-IMG-003 for CreateContainerConfigError', () => {
    expect(ERROR_CODES.IMG_003).toBe('ARC-IMG-003')
  })

  it('defines ARC-VOL-001 for FailedMount', () => {
    expect(ERROR_CODES.VOL_001).toBe('ARC-VOL-001')
  })

  it('defines ARC-VOL-002 for FailedBinding', () => {
    expect(ERROR_CODES.VOL_002).toBe('ARC-VOL-002')
  })

  it('defines ARC-RUNTIME-001 for OOMKilled', () => {
    expect(ERROR_CODES.RUNTIME_001).toBe('ARC-RUNTIME-001')
  })

  it('defines ARC-RUNTIME-002 for non-zero exit', () => {
    expect(ERROR_CODES.RUNTIME_002).toBe('ARC-RUNTIME-002')
  })
})

describe('formatErrorCode', () => {
  it('wraps code in square brackets', () => {
    expect(formatErrorCode(ERROR_CODES.IMG_001)).toBe('[ARC-IMG-001]')
  })

  it('wraps NPU code in square brackets', () => {
    expect(formatErrorCode(ERROR_CODES.NPU_8020)).toBe('[ARC-NPU-8020]')
  })

  it('wraps SCHED code in square brackets', () => {
    expect(formatErrorCode(ERROR_CODES.SCHED_001)).toBe('[ARC-SCHED-001]')
  })
})
