export const SOAK_WINDOW_SETTLED_EVENTS = 20_000
export const SOAK_REQUIRED_WINDOWS = 5
export const SOAK_FULL_SETTLED_EVENTS = SOAK_WINDOW_SETTLED_EVENTS * SOAK_REQUIRED_WINDOWS

export interface PercentileSummary {
  readonly samples: number
  readonly p50: number | null
  readonly p95: number | null
  readonly p99: number | null
  readonly min: number | null
  readonly max: number | null
}

export interface SoakMemoryWindow {
  readonly index: number
  readonly settledStart: number
  readonly settledEnd: number
  readonly midpoint: number
  readonly complete: boolean
  readonly heapUsedBeforeGc: number
  readonly heapUsedAfterGc: number
  readonly rss: number
}

export interface RegressionStats {
  readonly slopeMbPer10k: number
  readonly rSquared: number
  readonly monotonicIncreaseRatio: number
}

export interface MemoryGateThresholds {
  readonly heapRatio: number
  readonly rssRatio: number
  readonly slopeMbPer10k: number
  readonly monotonicIncreaseRatio: number
  readonly rSquared: number
}

export const SOAK_MEMORY_THRESHOLDS: MemoryGateThresholds = Object.freeze({
  heapRatio: 1.25,
  rssRatio: 1.5,
  slopeMbPer10k: 1,
  monotonicIncreaseRatio: 0.9,
  rSquared: 0.8,
})

export interface MemoryGateResult {
  readonly eligible: boolean
  readonly pass: boolean
  readonly windows: number
  readonly baselineWindow: number | null
  readonly finalWindow: number | null
  readonly heapFinalToBaselineRatio: number | null
  readonly rssFinalToBaselineRatio: number | null
  readonly heapMaxToBaselineRatio: number | null
  readonly rssMaxToBaselineRatio: number | null
  readonly heapTrend: RegressionStats | null
  readonly rssTrend: RegressionStats | null
  readonly checks: {
    readonly completeWindows: boolean
    readonly finiteSamples: boolean
    readonly heapRatio: boolean
    readonly rssRatio: boolean
    readonly heapSlope: boolean
    readonly rssSlope: boolean
    readonly heapMonotonic: boolean
    readonly rssMonotonic: boolean
    readonly heapRSquared: boolean
    readonly rssRSquared: boolean
  }
  readonly errors: readonly string[]
  readonly thresholds: MemoryGateThresholds
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function requireFinite(values: readonly number[], label: string): void {
  if (values.length === 0) throw new RangeError(`${label} requires at least one sample`)
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError(`${label} contains a non-finite sample`)
  }
}

/** Sorted nearest-rank percentile, as fixed by plan §10.1. */
export function nearestRank(samples: readonly number[], percentile: number): number {
  requireFinite(samples, 'nearestRank')
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new RangeError('nearestRank percentile must be in (0, 100]')
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((percentile / 100) * sorted.length)
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))]!
}

export function percentileSummary(samples: readonly number[]): PercentileSummary {
  if (samples.length === 0) {
    return { samples: 0, p50: null, p95: null, p99: null, min: null, max: null }
  }
  requireFinite(samples, 'percentileSummary')
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    samples: sorted.length,
    p50: round(nearestRank(sorted, 50), 3),
    p95: round(nearestRank(sorted, 95), 3),
    p99: round(nearestRank(sorted, 99), 3),
    min: round(sorted[0]!, 3),
    max: round(sorted.at(-1)!, 3),
  }
}

/**
 * Least-squares regression over window midpoints. Slope is normalized to
 * MiB/10k settled events. A constant y sequence has R² exactly 0.
 */
export function leastSquaresTrend(
  samples: readonly { readonly midpoint: number; readonly bytes: number }[],
): RegressionStats {
  if (samples.length < 2) throw new RangeError('leastSquaresTrend requires at least two samples')
  const xs = samples.map((sample) => sample.midpoint)
  const ys = samples.map((sample) => sample.bytes)
  requireFinite(xs, 'leastSquaresTrend midpoints')
  requireFinite(ys, 'leastSquaresTrend bytes')

  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let xx = 0
  let xy = 0
  for (let index = 0; index < xs.length; index += 1) {
    const dx = xs[index]! - xMean
    xx += dx * dx
    xy += dx * (ys[index]! - yMean)
  }
  if (xx === 0) throw new RangeError('leastSquaresTrend requires distinct midpoints')
  const slopeBytesPerEvent = xy / xx
  const intercept = yMean - slopeBytesPerEvent * xMean
  let residual = 0
  let total = 0
  for (let index = 0; index < xs.length; index += 1) {
    const actual = ys[index]!
    const fitted = intercept + slopeBytesPerEvent * xs[index]!
    residual += (actual - fitted) ** 2
    total += (actual - yMean) ** 2
  }
  const rSquared = total === 0 ? 0 : Math.max(0, Math.min(1, 1 - residual / total))
  let increases = 0
  for (let index = 1; index < ys.length; index += 1) {
    if (ys[index]! > ys[index - 1]!) increases += 1
  }
  return {
    slopeMbPer10k: round((slopeBytesPerEvent * 10_000) / (1024 * 1024)),
    rSquared: round(rSquared),
    monotonicIncreaseRatio: round(increases / (ys.length - 1)),
  }
}

function validWindow(window: SoakMemoryWindow, index: number): string[] {
  const errors: string[] = []
  if (window.index !== index) errors.push(`window[${index}] index must be ${index}`)
  if (!window.complete) errors.push(`window[${index}] is incomplete`)
  if (window.settledEnd - window.settledStart !== SOAK_WINDOW_SETTLED_EVENTS) {
    errors.push(`window[${index}] does not span ${SOAK_WINDOW_SETTLED_EVENTS} settled events`)
  }
  if (window.midpoint !== (window.settledStart + window.settledEnd) / 2) {
    errors.push(`window[${index}] midpoint is not the settled range midpoint`)
  }
  for (const field of ['heapUsedBeforeGc', 'heapUsedAfterGc', 'rss'] as const) {
    if (!Number.isFinite(window[field]) || window[field] <= 0) {
      errors.push(`window[${index}].${field} must be finite and positive`)
    }
  }
  return errors
}

/** §10.1 memory gate. Every check is combined with AND; no OR waiver exists. */
export function evaluateMemoryGate(
  windows: readonly SoakMemoryWindow[],
  thresholds: MemoryGateThresholds = SOAK_MEMORY_THRESHOLDS,
): MemoryGateResult {
  const errors: string[] = []
  const selected = [...windows]
  const completeWindows = selected.length >= SOAK_REQUIRED_WINDOWS
  if (!completeWindows) errors.push(`requires ${SOAK_REQUIRED_WINDOWS} complete windows, got ${selected.length}`)
  for (let index = 0; index < selected.length; index += 1) errors.push(...validWindow(selected[index]!, index))
  const finiteSamples = errors.every((error) => !/finite and positive/u.test(error))

  const baseline = selected[0] ?? null
  const final = selected.at(-1) ?? null
  const canCompute = completeWindows && errors.length === 0 && baseline !== null && final !== null
  let heapRatio: number | null = null
  let rssRatio: number | null = null
  let heapMaxRatio: number | null = null
  let rssMaxRatio: number | null = null
  let heapTrend: RegressionStats | null = null
  let rssTrend: RegressionStats | null = null
  if (canCompute) {
    heapRatio = round(final.heapUsedAfterGc / baseline.heapUsedAfterGc)
    rssRatio = round(final.rss / baseline.rss)
    heapMaxRatio = round(Math.max(...selected.map(window => window.heapUsedAfterGc / baseline.heapUsedAfterGc)))
    rssMaxRatio = round(Math.max(...selected.map(window => window.rss / baseline.rss)))
    try {
      heapTrend = leastSquaresTrend(selected.map((window) => ({ midpoint: window.midpoint, bytes: window.heapUsedAfterGc })))
      rssTrend = leastSquaresTrend(selected.map((window) => ({ midpoint: window.midpoint, bytes: window.rss })))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  const checks = {
    completeWindows: canCompute,
    finiteSamples: canCompute && finiteSamples,
    heapRatio: heapMaxRatio !== null && heapMaxRatio <= thresholds.heapRatio,
    rssRatio: rssMaxRatio !== null && rssMaxRatio <= thresholds.rssRatio,
    heapSlope: heapTrend !== null && heapTrend.slopeMbPer10k <= thresholds.slopeMbPer10k,
    rssSlope: rssTrend !== null && rssTrend.slopeMbPer10k <= thresholds.slopeMbPer10k,
    heapMonotonic: heapTrend !== null && heapTrend.monotonicIncreaseRatio < thresholds.monotonicIncreaseRatio,
    rssMonotonic: rssTrend !== null && rssTrend.monotonicIncreaseRatio < thresholds.monotonicIncreaseRatio,
    heapRSquared: heapTrend !== null && heapTrend.rSquared < thresholds.rSquared,
    rssRSquared: rssTrend !== null && rssTrend.rSquared < thresholds.rSquared,
  }
  const pass = Object.values(checks).every(Boolean)
  if (canCompute && !pass) {
    for (const [name, ok] of Object.entries(checks)) {
      if (!ok) errors.push(`memory gate failed: ${name}`)
    }
  }
  return {
    eligible: canCompute,
    pass,
    windows: windows.length,
    baselineWindow: baseline?.index ?? null,
    finalWindow: final?.index ?? null,
    heapFinalToBaselineRatio: heapRatio,
    rssFinalToBaselineRatio: rssRatio,
    heapMaxToBaselineRatio: heapMaxRatio,
    rssMaxToBaselineRatio: rssMaxRatio,
    heapTrend,
    rssTrend,
    checks,
    errors,
    thresholds,
  }
}
