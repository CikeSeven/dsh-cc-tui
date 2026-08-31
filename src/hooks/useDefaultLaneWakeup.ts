import React from 'react'

/**
 * Store-change wakeup without useSyncExternalStore. A uSES notification
 * forces a SYNCLANE re-render (forceStoreRerender hardcodes lane 2); when
 * the store bumps faster than renders finish — streaming several chunks per
 * frame on a slow terminal — each forced sync render preempts the in-flight
 * DefaultLane render and its commit ends with work still pending, which
 * React's commit-end lane accounting counts as a nested update. 50
 * consecutive dirty commits throw error #185 from whatever timer dispatches
 * next (the beta.3 crash; here the channel store is the bump source). A
 * manual subscription dispatches setState from the notify callback at
 * DEFAULT lane (no current event → DefaultEventPriority): the wakeup
 * coalesces into the in-flight render instead of preempting it, so bursts
 * collapse into one render per window and commits end clean.
 *
 * Use only where the uSES return value is discarded and store fields are
 * read fresh during render — the hook trades uSES's tearing protection for
 * coalescing, which is exactly what such call sites want.
 */
export function useDefaultLaneWakeup(subscribe: (listener: () => void) => () => void): void {
  const [, bump] = React.useState(0)
  React.useEffect(() => {
    // Catch up on any notification that fired between the first render and
    // this effect's mount — the subscription alone would miss it.
    bump(n => n + 1)
    return subscribe(() => bump(n => n + 1))
  }, [subscribe])
}
