/**
 * tui-v2 terminal profile contract (WP-02, plan §5.4).
 *
 * This is the immutable profile input to `terminal/capabilities.ts`; probing
 * uses the existing 150 ms/300 ms query budget. Dependency rule (§4.3):
 * terminal contracts import nothing from model/renderer/components.
 *
 * `Capability` is `'yes' | 'no' | 'unknown'`; `unknown` must never be treated
 * as supported. When probing fails, the renderer disables advanced protocols
 * and falls back to conservative full redraws (`unknown-conservative`).
 */

export type Capability = 'yes' | 'no' | 'unknown'
export type ImageProtocol = 'kitty' | 'iterm2' | null
export type ProfileMouseTracking = 'off' | 'x10-1000' | 'normal-1002' | 'button-1002' | 'any-1003' | 'sgr-1006' | 'urxvt-1015'
export type ProfileMouseEncoding = 'sgr-1006' | 'urxvt-1015' | 'x10'

export interface TerminalProfile {
  id: string
  family: 'kitty' | 'iterm2' | 'windows-terminal' | 'conpty' | 'conhost' | 'jetbrains' | 'zed' | 'vscode' | 'unknown'
  term: string
  colorTerm?: string
  locale?: string
  columns: number
  rows: number
  ambiguousWidth: 1 | 2 | 'unknown'
  unicodeLevel: number | 'unknown'
  supportsSyncOutput: Capability
  supportsKittyKeyboard: Capability
  supportsBracketedPaste: Capability
  supportsFocusReporting: Capability
  supportsModifyOtherKeys: Capability
  supportsWindowsDec9001: Capability
  supportsOsc8Hyperlinks: Capability
  supportsOsc52: Capability
  supportsOsc133: Capability
  supportsTabTitle: Capability
  supportsOsc11: Capability
  supportsXtvVersion: Capability
  supportsCellSizeQuery: Capability
  supportsProgress: Capability
  supportsTrueColor: Capability
  supportsMouse: Capability
  /** Preferred tracking mode; absent means the lifecycle default. */
  mouseTracking?: ProfileMouseTracking
  /** Preferred encoding; absent means SGR when available. */
  mouseEncoding?: ProfileMouseEncoding
  /** Protocols accepted by the host fixture/detector. */
  mouseProtocols?: readonly ProfileMouseEncoding[]
  supportsAlternateScreen: Capability
  imageProtocol: ImageProtocol | 'unknown'
  multiplexer: 'none' | 'tmux' | 'screen' | 'zellij' | 'unknown'
  platform: NodeJS.Platform
}

/** Profile id used whenever probing times out or the terminal is unrecognized. */
export const UNKNOWN_CONSERVATIVE_PROFILE_ID = 'unknown-conservative'

/**
 * Deterministic defaults for `unknown-conservative` (§5.4): ambiguousWidth 1,
 * unicodeLevel 'unknown', every advanced capability 'unknown', imageProtocol
 * 'unknown', multiplexer 'unknown'. The renderer treats 'unknown' as "off":
 * no sync output, no Kitty keyboard, no OSC52, no mouse, no images, full
 * redraws, and no alternate screen (`supportsAlternateScreen !== 'yes'`
 * forces the inline/non-interactive degradation path).
 */
export function unknownConservativeDefaults(): TerminalProfile {
  return {
    id: UNKNOWN_CONSERVATIVE_PROFILE_ID,
    family: 'unknown',
    term: 'unknown',
    columns: 80,
    rows: 24,
    ambiguousWidth: 1,
    unicodeLevel: 'unknown',
    supportsSyncOutput: 'unknown',
    supportsKittyKeyboard: 'unknown',
    supportsBracketedPaste: 'unknown',
    supportsFocusReporting: 'unknown',
    supportsModifyOtherKeys: 'unknown',
    supportsWindowsDec9001: 'unknown',
    supportsOsc8Hyperlinks: 'unknown',
    supportsOsc52: 'unknown',
    supportsOsc133: 'unknown',
    supportsTabTitle: 'unknown',
    supportsOsc11: 'unknown',
    supportsXtvVersion: 'unknown',
    supportsCellSizeQuery: 'unknown',
    supportsProgress: 'unknown',
    supportsTrueColor: 'unknown',
    supportsMouse: 'unknown',
    supportsAlternateScreen: 'unknown',
    imageProtocol: 'unknown',
    multiplexer: 'unknown',
    platform: process.platform,
  }
}
