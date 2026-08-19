/**
 * Terminal mode selection (WP-04).
 *
 * fullscreen requires `profile.supportsAlternateScreen === 'yes'`; the
 * 'unknown' capability is never treated as supported (§5.4 conservative):
 *
 *   requested 'fullscreen' + capability 'yes'      → fullscreen
 *   requested 'fullscreen' + capability no/unknown → unsupported-alternate-screen error
 *   requested 'inline'                              → inline
 *   default + capability 'yes'                      → fullscreen
 *   default + capability no/unknown                 → inline (degraded)
 */

import type { TerminalMode } from '../model/schema.js';
import type { TerminalProfile } from '../terminal/profile.js';

export type RequestedTerminalMode = TerminalMode | undefined;

export type ModeSelection =
  | { readonly ok: true; readonly mode: TerminalMode; readonly degraded: boolean }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'unsupported-alternate-screen';
        readonly message: string;
        readonly recoverable: false;
      };
    };

export function selectTerminalMode(
  profile: TerminalProfile,
  requested: RequestedTerminalMode,
): ModeSelection {
  const altScreen = profile.supportsAlternateScreen === 'yes';
  if (requested === 'inline') return { ok: true, mode: 'inline', degraded: false };
  if (requested === 'fullscreen') {
    if (altScreen) return { ok: true, mode: 'fullscreen', degraded: false };
    return {
      ok: false,
      error: {
        code: 'unsupported-alternate-screen',
        message: `fullscreen mode requires alternate-screen support; profile '${profile.id}' reports '${profile.supportsAlternateScreen}'`,
        recoverable: false,
      },
    };
  }
  // Default: fullscreen when the capability is proven, inline otherwise.
  return altScreen
    ? { ok: true, mode: 'fullscreen', degraded: false }
    : { ok: true, mode: 'inline', degraded: true };
}
