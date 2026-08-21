/**
 * Minimal `ScreenTakeover` (plan §6.6 contract, §7.4 scene semantics; WP-08a).
 *
 * The contract types are pinned in `terminal/lifecycle.ts`; this module
 * implements the subset the scene runtime needs:
 *
 *  - `request(ownerKind, reason)` — single-lease gate (a second request while
 *    a lease is current is REJECTED and the current owner keeps the screen),
 *    opaque token minted here only, mode snapshot captured as the restore
 *    baseline, and a REAL writer barrier obtained via `quiesce()` and
 *    immediately released via `resume()`: in-band owners (scenes) keep
 *    rendering through the v2 writer, so the barrier marks a settled patch
 *    watermark at takeover time instead of holding the writer hostage.
 *  - `restore(token, options)` — validates the opaque token by object
 *    identity (a forged/copy token can never release somebody else's tty),
 *    bumps the lifecycle generation (writer watermarks reset on the next
 *    frame; input generation follows via `lifecycle.setGeneration`) and
 *    invokes the host's `onRestore` hook (the coordinator turns it into a
 *    full redraw). Restoring the same token twice returns the SAME completed
 *    promise (idempotent, §7.4 close/teardown once-only semantics).
 *
 * NOT implemented here (deferred to the external-editor/update takeover,
 * plan WP-08 item 6 — recorded in §15.1): stdin/tty transfer to a child
 * process, holding the writer quiesced for the lease's lifetime, and mode
 * snapshot re-application. Scenes render in-band through the active backend,
 * so none of those move for them.
 *
 * Dependency rule (§4.3): node + import type from terminal contracts only.
 */
import { randomUUID } from 'node:crypto'

import type { TerminalLifecycle, ScreenTakeover, TakeoverLease, TakeoverSuspension, TakeoverToken } from './lifecycle.js'
import type { TerminalWriter } from './writer.js'

/** Narrow lifecycle surface the takeover needs (satisfied by TerminalLifecycle). */
export type TakeoverLifecycle = Pick<
  TerminalLifecycle,
  'generation' | 'setGeneration' | 'currentModeSnapshot' | 'suspendForTakeover' | 'resumeFromTakeover'
>

/** Narrow writer surface the takeover needs (satisfied by TerminalWriter). */
export type TakeoverWriter = Pick<TerminalWriter, 'quiesce' | 'resume'>

export interface ScreenTakeoverDeps {
  readonly lifecycle: TakeoverLifecycle
  readonly writer: TakeoverWriter
  /** Host hook after a successful restore (the coordinator's full-redraw mark). */
  readonly onRestore?: (lease: TakeoverLease, reason: 'completed' | 'cancelled' | 'error' | 'teardown') => void
  readonly onDiagnostic?: (code: string, message: string, details?: Record<string, unknown>) => void
}

interface LeaseRecord {
  readonly lease: TakeoverLease
  readonly suspension: TakeoverSuspension | null
  /** Set on the first restore; repeated restores return it unchanged. */
  restorePromise: Promise<void> | null
}

/** Minted-token registry: restore validates by identity, never by shape. */
const mintedTokens = new WeakSet<object>()

export function createScreenTakeover(deps: ScreenTakeoverDeps): ScreenTakeover {
  const diagnostic = (code: string, message: string, details?: Record<string, unknown>): void => {
    try {
      deps.onDiagnostic?.(code, message, details)
    } catch {
      /* diagnostics never break the takeover gate */
    }
  }

  let current: LeaseRecord | null = null
  /** Last restored lease, for idempotent repeated restores of the same token. */
  let lastRestored: LeaseRecord | null = null

  async function request(ownerKind: TakeoverToken['ownerKind'], reason: string): Promise<TakeoverLease> {
    if (current !== null) {
      // One lease at a time (§6.6): reject and KEEP the current owner.
      diagnostic(
        'takeover/busy',
        `takeover request by "${ownerKind}" rejected: lease held by "${current.lease.token.ownerKind}"`,
        { reason },
      )
      throw new Error(
        `dsh-tui: screen takeover is busy (held by ${current.lease.token.ownerKind}#${current.lease.token.id})`,
      )
    }
    // Capture the pre-child mode before suspension clears the physical modes.
    const modeBeforeTakeover = deps.lifecycle.currentModeSnapshot()
    // Child owners keep the writer/input suspended for the lease lifetime;
    // scene owners retain the existing in-band settled-watermark behavior.
    const suspension = ownerKind === 'external-editor' || ownerKind === 'update' || ownerKind === 'shutdown'
      ? await deps.lifecycle.suspendForTakeover?.() ?? null
      : null
    const barrier = suspension?.barrier ?? await deps.writer.quiesce()
    if (suspension === null) deps.writer.resume(barrier, barrier.generation)
    const generation = deps.lifecycle.generation()
    const token = {
      id: randomUUID(),
      ownerKind,
      generation,
      __opaqueTakeoverToken: Symbol(`takeover:${ownerKind}`),
    } as unknown as TakeoverToken
    mintedTokens.add(token)
    const lease: TakeoverLease = Object.freeze({
      token,
      generation,
      modeBeforeTakeover,
      barrier,
    })
    current = { lease, suspension, restorePromise: null }
    diagnostic('takeover/requested', `takeover lease issued to "${ownerKind}"`, { reason, generation })
    return lease
  }

  // NOT async: an async function would wrap the returned promise in a fresh
  // object, breaking the §7.4 once-only "same promise" identity guarantee.
  function restore(
    token: TakeoverToken,
    options?: { reason?: 'completed' | 'cancelled' | 'error' | 'teardown' },
  ): Promise<void> {
    const reason = options?.reason ?? 'completed'
    if (current !== null && token === current.lease.token) {
      const record = current
      record.restorePromise ??= (async () => {
        current = null
        // Child takeover restoration re-enables modes/input and advances the
        // generation; in-band scenes retain the historical generation bump.
        if (record.suspension !== null) {
          await deps.lifecycle.resumeFromTakeover?.(record.suspension)
        } else {
          deps.lifecycle.setGeneration(record.lease.generation + 1)
        }
        lastRestored = record
        diagnostic('takeover/restored', `takeover lease of "${record.lease.token.ownerKind}" restored`, {
          reason,
          generation: record.lease.generation + 1,
        })
        try {
          deps.onRestore?.(record.lease, reason)
        } catch (error) {
          diagnostic('takeover/restore-hook-error', error instanceof Error ? error.message : String(error))
        }
      })()
      return record.restorePromise
    }
    if (lastRestored !== null && token === lastRestored.lease.token && lastRestored.restorePromise !== null) {
      // Idempotent success (§6.6: 重复 restore 同一 token 是幂等成功).
      return lastRestored.restorePromise
    }
    // A wrong/forged token lands in cleanup/error only — it must never
    // release another owner's lease (§6.6). Promise.reject (not throw): the
    // non-async identity guarantee above must not turn contract violations
    // into synchronous throws at the coordinator.
    diagnostic('takeover/restore-rejected', 'restore called with an unknown or foreign token')
    return Promise.reject(new Error('dsh-tui: screen takeover restore rejected (unknown or foreign token)'))
  }

  return {
    request,
    restore,
    current: () => (current === null ? null : { token: current.lease.token, generation: current.lease.generation }),
  }
}

/** Test/introspection guard: true only for tokens minted by a ScreenTakeover. */
export function isMintedTakeoverToken(token: unknown): token is TakeoverToken {
  return typeof token === 'object' && token !== null && mintedTokens.has(token)
}
