/**
 * tui-v2 deterministic emulator terminal profiles (WP-02, plan §9.4).
 *
 * These are FIXTURE profiles for the virtual terminal / differential oracle —
 * not claims about what a real host supports. Every entry is a complete
 * `TerminalProfile` with a stated rationale; `unknown-conservative` is built
 * from `unknownConservativeDefaults()` (§5.4) and must keep its conservative
 * values. Real-host coverage is a separate manual gate (§9.4).
 */
import {
  unknownConservativeDefaults,
  type TerminalProfile,
} from '../terminal/profile.js'

/** vt100-class ASCII terminal: no color beyond none, no mouse, no OSC. */
const ASCII_NARROW: TerminalProfile = {
  id: 'ascii-narrow',
  family: 'unknown',
  term: 'vt100',
  columns: 80,
  rows: 24,
  ambiguousWidth: 1,
  unicodeLevel: 0,
  supportsSyncOutput: 'no',
  supportsKittyKeyboard: 'no',
  supportsBracketedPaste: 'no',
  supportsFocusReporting: 'no',
  supportsModifyOtherKeys: 'no',
  supportsWindowsDec9001: 'no',
  supportsOsc8Hyperlinks: 'no',
  supportsOsc52: 'no',
  supportsOsc133: 'no',
  supportsTabTitle: 'no',
  supportsOsc11: 'no',
  supportsXtvVersion: 'no',
  supportsCellSizeQuery: 'no',
  supportsProgress: 'no',
  supportsTrueColor: 'no',
  supportsMouse: 'no',
  supportsAlternateScreen: 'yes',
  imageProtocol: null,
  multiplexer: 'none',
  platform: 'linux',
}

/** xterm-256color-class: ambiguous East-Asian chars measured narrow (glibc default). */
const UNICODE_AMBIGUOUS_NARROW: TerminalProfile = {
  id: 'unicode-ambiguous-narrow',
  family: 'unknown',
  term: 'xterm-256color',
  locale: 'en_US.UTF-8',
  columns: 120,
  rows: 40,
  ambiguousWidth: 1,
  unicodeLevel: 2,
  supportsSyncOutput: 'no',
  supportsKittyKeyboard: 'no',
  supportsBracketedPaste: 'yes',
  supportsFocusReporting: 'yes',
  supportsModifyOtherKeys: 'no',
  supportsWindowsDec9001: 'no',
  supportsOsc8Hyperlinks: 'yes',
  supportsOsc52: 'yes',
  supportsOsc133: 'no',
  supportsTabTitle: 'yes',
  supportsOsc11: 'yes',
  supportsXtvVersion: 'yes',
  supportsCellSizeQuery: 'no',
  supportsProgress: 'no',
  supportsTrueColor: 'no',
  supportsMouse: 'yes',
  mouseTracking: 'sgr-1006',
  mouseEncoding: 'sgr-1006',
  mouseProtocols: ['sgr-1006', 'urxvt-1015', 'x10'],
  supportsAlternateScreen: 'yes',
  imageProtocol: null,
  multiplexer: 'none',
  platform: 'linux',
}

/** Same terminal class with ambiguous chars measured wide (e.g. East-Asian locale settings). */
const UNICODE_AMBIGUOUS_WIDE: TerminalProfile = {
  ...UNICODE_AMBIGUOUS_NARROW,
  id: 'unicode-ambiguous-wide',
  locale: 'zh_CN.UTF-8',
  ambiguousWidth: 2,
}

/** Kitty: sync output, Kitty keyboard protocol, cell-size query, Kitty images. */
const KITTY_SYNC: TerminalProfile = {
  id: 'kitty-sync',
  family: 'kitty',
  term: 'xterm-kitty',
  colorTerm: 'truecolor',
  locale: 'en_US.UTF-8',
  columns: 120,
  rows: 40,
  ambiguousWidth: 1,
  unicodeLevel: 2,
  supportsSyncOutput: 'yes',
  supportsKittyKeyboard: 'yes',
  supportsBracketedPaste: 'yes',
  supportsFocusReporting: 'yes',
  supportsModifyOtherKeys: 'yes',
  supportsWindowsDec9001: 'no',
  supportsOsc8Hyperlinks: 'yes',
  supportsOsc52: 'yes',
  supportsOsc133: 'yes',
  supportsTabTitle: 'yes',
  supportsOsc11: 'yes',
  supportsXtvVersion: 'yes',
  supportsCellSizeQuery: 'yes',
  supportsProgress: 'no',
  supportsTrueColor: 'yes',
  supportsMouse: 'yes',
  mouseTracking: 'sgr-1006',
  mouseEncoding: 'sgr-1006',
  mouseProtocols: ['sgr-1006', 'urxvt-1015', 'x10'],
  supportsAlternateScreen: 'yes',
  imageProtocol: 'kitty',
  multiplexer: 'none',
  platform: 'linux',
}

/** iTerm2 fixture: OSC 1337 images, no Kitty keyboard/image protocol. */
const ITERM2_IMAGES: TerminalProfile = {
  ...KITTY_SYNC,
  id: 'iterm2-images',
  family: 'iterm2',
  term: 'xterm-256color',
  locale: 'en_US.UTF-8',
  supportsKittyKeyboard: 'no',
  supportsModifyOtherKeys: 'yes',
  supportsCellSizeQuery: 'yes',
  imageProtocol: 'iterm2',
  platform: 'darwin',
}

/** tmux 3.x multiplexer: filters/passes a reduced protocol set; no sync output, no images. */
const TMUX: TerminalProfile = {
  id: 'tmux',
  family: 'unknown',
  term: 'tmux-256color',
  colorTerm: 'truecolor',
  locale: 'en_US.UTF-8',
  columns: 120,
  rows: 40,
  ambiguousWidth: 1,
  unicodeLevel: 2,
  supportsSyncOutput: 'no',
  supportsKittyKeyboard: 'no',
  supportsBracketedPaste: 'yes',
  supportsFocusReporting: 'yes',
  supportsModifyOtherKeys: 'no',
  supportsWindowsDec9001: 'no',
  supportsOsc8Hyperlinks: 'yes',
  supportsOsc52: 'yes',
  supportsOsc133: 'no',
  supportsTabTitle: 'yes',
  supportsOsc11: 'no',
  supportsXtvVersion: 'no',
  supportsCellSizeQuery: 'no',
  supportsProgress: 'no',
  supportsTrueColor: 'yes',
  supportsMouse: 'yes',
  mouseTracking: 'sgr-1006',
  mouseEncoding: 'sgr-1006',
  mouseProtocols: ['sgr-1006', 'urxvt-1015', 'x10'],
  supportsAlternateScreen: 'yes',
  imageProtocol: null,
  multiplexer: 'tmux',
  platform: 'linux',
}

/** SSH session into a remote xterm-256color host: latency-safe subset, truecolor unverified. */
const SSH: TerminalProfile = {
  id: 'ssh',
  family: 'unknown',
  term: 'xterm-256color',
  locale: 'en_US.UTF-8',
  columns: 80,
  rows: 24,
  ambiguousWidth: 1,
  unicodeLevel: 2,
  supportsSyncOutput: 'no',
  supportsKittyKeyboard: 'no',
  supportsBracketedPaste: 'yes',
  supportsFocusReporting: 'yes',
  supportsModifyOtherKeys: 'no',
  supportsWindowsDec9001: 'no',
  supportsOsc8Hyperlinks: 'yes',
  supportsOsc52: 'unknown',
  supportsOsc133: 'no',
  supportsTabTitle: 'yes',
  supportsOsc11: 'unknown',
  supportsXtvVersion: 'unknown',
  supportsCellSizeQuery: 'no',
  supportsProgress: 'no',
  supportsTrueColor: 'unknown',
  supportsMouse: 'yes',
  mouseTracking: 'sgr-1006',
  mouseEncoding: 'sgr-1006',
  mouseProtocols: ['sgr-1006', 'x10'],
  supportsAlternateScreen: 'yes',
  imageProtocol: null,
  multiplexer: 'none',
  platform: 'linux',
}

/** ConPTY-hosted app with an unspecified client: xterm emulation + DECAWM/DEC9001, OSC 8 unverified. */
const WINDOWS_CONPTY: TerminalProfile = {
  id: 'windows-conpty',
  family: 'conpty',
  term: 'xterm-256color',
  locale: 'en-US',
  columns: 120,
  rows: 30,
  ambiguousWidth: 1,
  unicodeLevel: 2,
  supportsSyncOutput: 'no',
  supportsKittyKeyboard: 'no',
  supportsBracketedPaste: 'yes',
  supportsFocusReporting: 'yes',
  supportsModifyOtherKeys: 'no',
  supportsWindowsDec9001: 'yes',
  supportsOsc8Hyperlinks: 'unknown',
  supportsOsc52: 'no',
  supportsOsc133: 'no',
  supportsTabTitle: 'yes',
  supportsOsc11: 'no',
  supportsXtvVersion: 'no',
  supportsCellSizeQuery: 'no',
  supportsProgress: 'no',
  supportsTrueColor: 'yes',
  supportsMouse: 'yes',
  supportsAlternateScreen: 'yes',
  imageProtocol: null,
  multiplexer: 'none',
  platform: 'win32',
}

/** Windows Terminal + PowerShell: truecolor, OSC 8, DEC9001, OSC 9;4 progress. */
const WINDOWS_TERMINAL_POWERSHELL: TerminalProfile = {
  id: 'windows-terminal-powershell',
  family: 'windows-terminal',
  term: 'xterm-256color',
  colorTerm: 'truecolor',
  locale: 'en-US',
  columns: 120,
  rows: 30,
  ambiguousWidth: 1,
  unicodeLevel: 2,
  supportsSyncOutput: 'yes',
  supportsKittyKeyboard: 'no',
  supportsBracketedPaste: 'yes',
  supportsFocusReporting: 'yes',
  supportsModifyOtherKeys: 'no',
  supportsWindowsDec9001: 'yes',
  supportsOsc8Hyperlinks: 'yes',
  supportsOsc52: 'yes',
  supportsOsc133: 'yes',
  supportsTabTitle: 'yes',
  supportsOsc11: 'yes',
  supportsXtvVersion: 'no',
  supportsCellSizeQuery: 'no',
  supportsProgress: 'yes',
  supportsTrueColor: 'yes',
  supportsMouse: 'yes',
  supportsAlternateScreen: 'yes',
  imageProtocol: null,
  multiplexer: 'none',
  platform: 'win32',
}

/** Windows Terminal + cmd.exe: same host as powershell profile, legacy codepage shell. */
const WINDOWS_TERMINAL_CMD: TerminalProfile = {
  ...WINDOWS_TERMINAL_POWERSHELL,
  id: 'windows-terminal-cmd',
  locale: 'en-US',
  term: 'xterm-256color',
}

/** Classic conhost with UTF-8 codepage: VT subset only, no bracketed paste/focus/OSC 8. */
const CLASSIC_CONHOST_CP65001: TerminalProfile = {
  id: 'classic-conhost-cp65001',
  family: 'conhost',
  term: 'conhost',
  locale: 'en-US',
  columns: 80,
  rows: 25,
  ambiguousWidth: 1,
  unicodeLevel: 2,
  supportsSyncOutput: 'no',
  supportsKittyKeyboard: 'no',
  supportsBracketedPaste: 'no',
  supportsFocusReporting: 'no',
  supportsModifyOtherKeys: 'no',
  supportsWindowsDec9001: 'no',
  supportsOsc8Hyperlinks: 'no',
  supportsOsc52: 'no',
  supportsOsc133: 'no',
  supportsTabTitle: 'no',
  supportsOsc11: 'no',
  supportsXtvVersion: 'no',
  supportsCellSizeQuery: 'no',
  supportsProgress: 'no',
  supportsTrueColor: 'yes',
  supportsMouse: 'yes',
  supportsAlternateScreen: 'yes',
  imageProtocol: null,
  multiplexer: 'none',
  platform: 'win32',
}

/** Classic conhost with GBK codepage: ambiguous chars wide, limited Unicode repertoire. */
const CLASSIC_CONHOST_CP936: TerminalProfile = {
  ...CLASSIC_CONHOST_CP65001,
  id: 'classic-conhost-cp936',
  locale: 'zh-CN',
  ambiguousWidth: 2,
  unicodeLevel: 1,
}

/** VS Code integrated terminal (xterm.js): OSC 133 shell integration, no sync output/kitty. */
const VSCODE_TERMINAL: TerminalProfile = {
  id: 'vscode-terminal',
  family: 'vscode',
  term: 'xterm-256color',
  colorTerm: 'truecolor',
  locale: 'en_US.UTF-8',
  columns: 120,
  rows: 40,
  ambiguousWidth: 1,
  unicodeLevel: 2,
  supportsSyncOutput: 'no',
  supportsKittyKeyboard: 'no',
  supportsBracketedPaste: 'yes',
  supportsFocusReporting: 'yes',
  supportsModifyOtherKeys: 'no',
  supportsWindowsDec9001: 'no',
  supportsOsc8Hyperlinks: 'yes',
  supportsOsc52: 'yes',
  supportsOsc133: 'yes',
  supportsTabTitle: 'yes',
  supportsOsc11: 'yes',
  supportsXtvVersion: 'yes',
  supportsCellSizeQuery: 'no',
  supportsProgress: 'no',
  supportsTrueColor: 'yes',
  supportsMouse: 'yes',
  supportsAlternateScreen: 'yes',
  imageProtocol: null,
  multiplexer: 'none',
  platform: 'linux',
}

const PROFILE_LIST: readonly TerminalProfile[] = [
  ASCII_NARROW,
  UNICODE_AMBIGUOUS_NARROW,
  UNICODE_AMBIGUOUS_WIDE,
  KITTY_SYNC,
  ITERM2_IMAGES,
  TMUX,
  SSH,
  WINDOWS_CONPTY,
  WINDOWS_TERMINAL_POWERSHELL,
  WINDOWS_TERMINAL_CMD,
  CLASSIC_CONHOST_CP65001,
  CLASSIC_CONHOST_CP936,
  VSCODE_TERMINAL,
  // §5.4 deterministic fallback: every advanced capability 'unknown'.
  unknownConservativeDefaults(),
]

function freezeProfile(profile: TerminalProfile): TerminalProfile {
  return Object.freeze({
    ...profile,
    ...(profile.mouseProtocols === undefined ? {} : { mouseProtocols: Object.freeze([...profile.mouseProtocols]) }),
  })
}

export const PROFILES: ReadonlyMap<string, TerminalProfile> = new Map(
  PROFILE_LIST.map((profile) => [profile.id, freezeProfile(profile)]),
)

export function getProfile(id: string): TerminalProfile {
  const profile = PROFILES.get(id)
  if (!profile) {
    throw new RangeError(`unknown terminal profile id: ${id} (known: ${[...PROFILES.keys()].join(', ')})`)
  }
  return profile
}
