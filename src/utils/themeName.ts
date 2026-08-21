/** Safe identifier contract shared by persisted preferences and the v2 registry. */
export const SAFE_THEME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Return whether a value is a traversal-safe, single-segment theme id. */
export function isSafeThemeName(value: unknown): value is string {
  return typeof value === 'string' && SAFE_THEME_NAME_RE.test(value)
}
