/**
 * node:test custom reporter for the tui-v2 suite.
 *
 * Versioned JSONL schema (reporterVersion: 1): every input test event is
 * normalized to one JSON-safe line
 *   { reporterVersion: 1, type, name, nesting, data }
 * so wrappers can parse `--test-reporter-destination` output without
 * depending on a built-in `json` reporter (which does not exist on
 * Node 22/24).
 *
 * Default export: a factory returning an object-mode Transform. This form is
 * supported by node:test reporters on Node >= 18 (verified on 22.19/24/26).
 */
import { Transform } from 'node:stream'

export const reporterVersion = 1

/**
 * Normalize an arbitrary event payload into a JSON-safe value:
 * Error -> { name, message, code, stack }; function/symbol/undefined are
 * dropped; bigint -> string; circular references become '[Circular]'.
 */
export function normalize(value, seen = new WeakSet()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined
  }
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) {
    const out = { name: value.name, message: value.message }
    if (value.code !== undefined) out.code = normalize(value.code, seen)
    if (typeof value.stack === 'string') out.stack = value.stack
    return out
  }
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out = []
      for (const item of value) {
        const n = normalize(item, seen)
        // Arrays keep positions: dropped values become null so JSON shape stays stable.
        out.push(n === undefined ? null : n)
      }
      return out
    }
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const n = normalize(item, seen)
      if (n !== undefined) out[key] = n
    }
    return out
  } finally {
    seen.delete(value)
  }
}

export function normalizeEvent(event) {
  return {
    reporterVersion,
    type: typeof event?.type === 'string' ? event.type : 'unknown',
    name: typeof event?.name === 'string' ? event.name : null,
    nesting: typeof event?.nesting === 'number' ? event.nesting : 0,
    data: normalize(event?.data ?? {}) ?? {},
  }
}

export function createReporterStream() {
  return new Transform({
    writableObjectMode: true,
    transform(event, _encoding, callback) {
      let line
      try {
        line = JSON.stringify(normalizeEvent(event)) + '\n'
      } catch (error) {
        // Normalization must never kill the test run; emit a fallback record.
        line = JSON.stringify({
          reporterVersion,
          type: 'reporter:error',
          name: null,
          nesting: 0,
          data: { message: String(error && error.message ? error.message : error) },
        }) + '\n'
      }
      callback(null, line)
    },
  })
}

export default function tuiV2TestReporter() {
  return createReporterStream()
}
