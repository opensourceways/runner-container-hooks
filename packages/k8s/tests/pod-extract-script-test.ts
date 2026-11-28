import { podExtractScript } from '../src/k8s'

// The pod-side extraction script is embedded in shell strings that run on
// images shipping either GNU or busybox tar, against targets that may be
// mount points (non-root EPERM on utime/chmod) and containers that may run
// with a read-only rootfs. These tests pin the generated script so the
// fatal-vs-tolerated classification and the /tmp fallback cannot regress
// silently.
describe('podExtractScript', () => {
  it('treats data and IO errors as fatal, case-insensitively', () => {
    const script = podExtractScript('/__w', '')
    // The blocklist grep must run with -i: GNU tar prints
    // "Unexpected EOF in archive" while busybox capitalizes differently.
    expect(script).toContain("grep -qEi '")
    for (const pattern of [
      'Cannot read',
      'unexpected',
      'unrecognized',
      'No such',
      'short read',
      'Cannot open',
      'EOF',
      // A corrupt archive (truncated header) must be fatal, not tolerated:
      // without this pattern the failure would only surface after the full
      // 15-round listing verification (~15s later).
      'does not look like a tar archive'
    ]) {
      expect(script).toContain(pattern)
    }
  })

  it('surfaces tar stderr with the failure before removing the temp file', () => {
    const script = podExtractScript('/__w', '')
    const catIndex = script.indexOf('cat /tmp/.hooks-tar.err >&2')
    expect(catIndex).toBeGreaterThan(-1)
    // The stderr must be emitted (echo + cat) BEFORE the file is removed,
    // otherwise the thrown error carries no tar details at all.
    const rmIndex = script.indexOf('rm -f /tmp/.hooks-tar.err', catIndex)
    expect(rmIndex).toBeGreaterThan(catIndex)
    expect(script.indexOf('exit 1', rmIndex)).toBeGreaterThan(rmIndex)
  })

  it('falls back to discarding stderr when /tmp is not writable', () => {
    const script = podExtractScript('/__w', '')
    // The writability probe must be a subshell so a failed redirection on a
    // read-only rootfs does not abort the whole script.
    expect(script).toContain('if (true 2>/tmp/.hooks-tar.err) 2>/dev/null')
    // The fallback branch tolerates every non-zero exit (the listing
    // verification is the safety net) instead of failing the redirection
    // before tar even runs.
    expect(script).toContain('else')
    expect(script).toContain('2>/dev/null || true')
  })

  it('extracts with --no-same-owner and applies permission fixups', () => {
    const script = podExtractScript('/__w', '')
    expect(script).toContain('tar xf - --no-same-owner -C /__w')
    expect(script).toContain('chmod u+rw')
    expect(script).toContain('chmod u+rwx')
    expect(script).toContain('sync 2>/dev/null || true')
  })

  it('reads the archive from fd 3 on the direct channel and from stdin otherwise', () => {
    const direct = podExtractScript('/__w', '<&3')
    expect(direct).toContain(' -C /__w <&3 2>/tmp/.hooks-tar.err')

    const viaStdin = podExtractScript('/__w', '')
    expect(viaStdin).toContain(' -C /__w 2>/tmp/.hooks-tar.err')
    expect(viaStdin).not.toContain('<&3')
  })
})
