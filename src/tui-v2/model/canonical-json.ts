/**
 * tui-v2 canonical JSON serializer (WP-04, plan §5.2/§9.2).
 *
 * Canonical form: UTF-8, object keys in Unicode code-point order, arrays in
 * semantic order, numbers in ECMAScript shortest round-trip form, no
 * whitespace, no trailing newline. Used for snapshot hashes
 * (`computeSnapshotHash`), canonical state comparison (live/replay
 * equivalence, §5.2) and the testkit golden-grid bytes.
 *
 * This module lives in the model layer so both the model and the testkit can
 * share one implementation without the model depending on the testkit
 * (dependency direction §4.3: testkit -> model, never the reverse). The
 * testkit re-exports `canonicalJson` from here; its public API is unchanged.
 */
import { createHash } from 'node:crypto'

/** Compare two strings by Unicode code point (NOT UTF-16 code unit). */
function compareCodePoints(a: string, b: string): number {
  const pa = Array.from(a)
  const pb = Array.from(b)
  const n = Math.min(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const ca = pa[i].codePointAt(0) as number
    const cb = pb[i].codePointAt(0) as number
    if (ca !== cb) return ca - cb
  }
  return pa.length - pb.length
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: non-finite numbers are not representable')
      }
      // JSON.stringify uses the ECMAScript shortest round-trip decimal form.
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).sort(compareCodePoints)
      const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      return `{${parts.join(',')}}`
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`)
  }
}

/** sha256 over the UTF-8 bytes of a value's canonical JSON, lowercase hex. */
export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}
