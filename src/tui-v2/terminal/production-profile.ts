/**
 * Production terminal profile resolver (WP-09b).
 *
 * This is intentionally separate from `testkit/terminal-profiles.ts`: runtime
 * capability claims come only from the real TTY geometry, a small TERM
 * allowlist, platform, and presence bits for known wrapper/host variables.
 * Unknown TERM values are never copied into the profile or treated as support.
 *
 * Fullscreen policy is explicit: alternate-screen support is `yes` only for a
 * recognized xterm-compatible TERM or a known Windows Terminal / VS Code host,
 * `no` for dumb/ANSI/VT-only terms, and `unknown` otherwise. Consequently an
 * explicit fullscreen request fails before takeover through selectTerminalMode;
 * only an automatic mode selection may degrade an unknown host to inline.
 */
import { detectTerminalCapabilities, type TerminalCapabilitySnapshot } from './capabilities.js'
import {
  UNKNOWN_CONSERVATIVE_PROFILE_ID,
  unknownConservativeDefaults,
  type Capability,
  type TerminalProfile,
} from './profile.js'

export interface ProductionTerminalResolverInput {
  readonly stdout: {
    readonly isTTY?: boolean
    readonly columns?: number
    readonly rows?: number
  }
  readonly stdin?: {
    readonly isTTY?: boolean
    readonly setRawMode?: unknown
  }
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** Alias for embedders that call the allowlisted map `env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
}

export interface ProductionTerminalResolution {
  readonly profile: TerminalProfile
  readonly capabilities: TerminalCapabilitySnapshot
}

type TerminalClass = 'kitty' | 'xterm' | 'dumb' | 'unknown'

const TERM_TOKEN = /^[a-z0-9][a-z0-9+._-]{0,63}$/u
const XTERM_COMPATIBLE = /^(?:xterm(?:-[a-z0-9+._-]+)?|rxvt(?:-[a-z0-9+._-]+)?|screen(?:-[a-z0-9+._-]+)?|tmux(?:-[a-z0-9+._-]+)?)$/u
const DUMB_TERMS = new Set(['dumb', 'ansi', 'vt100', 'vt220', 'linux', 'cons25', 'emacs'])

function present(environment: ProductionTerminalResolverInput['environment'], key: string): boolean {
  return typeof environment?.[key] === 'string' && environment[key] !== ''
}

function normalizeTerm(value: string | undefined): string {
  const term = value?.trim().toLowerCase() ?? ''
  return TERM_TOKEN.test(term) ? term : 'unknown'
}

function normalizeColorTerm(value: string | undefined): 'truecolor' | '24bit' | undefined {
  const colorTerm = value?.trim().toLowerCase()
  return colorTerm === 'truecolor' || colorTerm === '24bit' ? colorTerm : undefined
}

function dimension(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback
}

function terminalClass(term: string): TerminalClass {
  if (term === 'xterm-kitty') return 'kitty'
  if (DUMB_TERMS.has(term)) return 'dumb'
  if (XTERM_COMPATIBLE.test(term)) return 'xterm'
  return 'unknown'
}

function capabilityFor(
  supported: boolean,
  denied: boolean,
): Capability {
  return supported ? 'yes' : denied ? 'no' : 'unknown'
}

/**
 * Resolve one immutable profile/capability pair for the current production
 * host. Only allowlisted values/presence bits are forwarded to the capability
 * detector; arbitrary environment contents never enter the snapshot.
 */
export function resolveProductionTerminalProfile(
  input: ProductionTerminalResolverInput,
): ProductionTerminalResolution {
  const environment = input.environment ?? input.env ?? {}
  const platform = input.platform ?? process.platform
  const columns = dimension(input.stdout.columns, 80)
  const rows = dimension(input.stdout.rows, 24)
  const term = normalizeTerm(environment.TERM)
  const colorTerm = normalizeColorTerm(environment.COLORTERM)
  const klass = terminalClass(term)
  const tty = input.stdout.isTTY === true

  const tmux = present(environment, 'TMUX') || term.startsWith('tmux-')
  const screen = !tmux && term.startsWith('screen-')
  const ssh = present(environment, 'SSH_CONNECTION')
    || present(environment, 'SSH_CLIENT')
    || present(environment, 'SSH_TTY')
  const vscode = present(environment, 'VSCODE_INJECTION') || present(environment, 'VSCODE_PID')
  const windowsTerminal = present(environment, 'WT_SESSION')

  const knownModernHost = vscode || windowsTerminal || klass === 'kitty' || klass === 'xterm'
  const explicitlyLimited = klass === 'dumb'
  const alternateScreen = tty
    ? capabilityFor(knownModernHost, explicitlyLimited)
    : 'unknown'
  const wrapped = tmux || screen || ssh || vscode
  const directKitty = tty && klass === 'kitty' && !wrapped
  const knownInteractive = tty && alternateScreen === 'yes'
  const directModernHost = tty && !tmux && !screen && !ssh
  const trueColor = colorTerm !== undefined || directKitty || windowsTerminal || vscode

  const family: TerminalProfile['family'] = vscode
    ? 'vscode'
    : windowsTerminal
      ? 'windows-terminal'
      : directKitty
        ? 'kitty'
        : platform === 'win32' && klass === 'xterm'
          ? 'conpty'
          : 'unknown'
  const multiplexer: TerminalProfile['multiplexer'] = tmux
    ? 'tmux'
    : screen
      ? 'screen'
      : 'none'

  const profile: TerminalProfile = !tty || (!knownModernHost && !explicitlyLimited)
    ? {
        ...unknownConservativeDefaults(),
        id: UNKNOWN_CONSERVATIVE_PROFILE_ID,
        term,
        ...(colorTerm === undefined ? {} : { colorTerm }),
        columns,
        rows,
        multiplexer,
        platform,
      }
    : {
        id: directKitty
          ? 'production-kitty'
          : vscode
            ? 'production-vscode'
            : windowsTerminal
              ? 'production-windows-terminal'
              : tmux
                ? 'production-tmux'
                : screen
                  ? 'production-screen'
                  : ssh
                    ? 'production-ssh-xterm'
                    : explicitlyLimited
                      ? 'production-limited'
                      : platform === 'win32'
                        ? 'production-conpty-xterm'
                        : 'production-xterm',
        family,
        term,
        ...(colorTerm === undefined ? {} : { colorTerm }),
        columns,
        rows,
        ambiguousWidth: 1,
        unicodeLevel: explicitlyLimited ? 0 : 2,
        supportsSyncOutput: directKitty ? 'yes' : knownInteractive ? 'no' : 'unknown',
        supportsKittyKeyboard: directKitty ? 'yes' : knownInteractive ? 'no' : 'unknown',
        supportsBracketedPaste: capabilityFor(knownInteractive, explicitlyLimited),
        supportsFocusReporting: capabilityFor(knownInteractive, explicitlyLimited),
        supportsModifyOtherKeys: directKitty ? 'yes' : knownInteractive ? 'no' : 'unknown',
        supportsWindowsDec9001: platform === 'win32' && (windowsTerminal || family === 'conpty')
          ? 'yes'
          : knownInteractive
            ? 'no'
            : 'unknown',
        supportsOsc8Hyperlinks: directKitty || windowsTerminal || vscode
          ? 'yes'
          : knownInteractive
            ? 'unknown'
            : explicitlyLimited
              ? 'no'
              : 'unknown',
        supportsOsc52: directModernHost && (directKitty || windowsTerminal || vscode)
          ? 'yes'
          : knownInteractive
            ? 'unknown'
            : explicitlyLimited
              ? 'no'
              : 'unknown',
        supportsOsc133: directKitty || windowsTerminal || vscode
          ? 'yes'
          : knownInteractive
            ? 'no'
            : 'unknown',
        supportsTabTitle: capabilityFor(knownInteractive, explicitlyLimited),
        supportsOsc11: directKitty || windowsTerminal || vscode
          ? 'yes'
          : knownInteractive
            ? 'unknown'
            : explicitlyLimited
              ? 'no'
              : 'unknown',
        supportsXtvVersion: directKitty ? 'yes' : knownInteractive ? 'unknown' : explicitlyLimited ? 'no' : 'unknown',
        supportsCellSizeQuery: directKitty ? 'yes' : knownInteractive ? 'no' : 'unknown',
        supportsProgress: windowsTerminal ? 'yes' : knownInteractive ? 'no' : 'unknown',
        supportsTrueColor: trueColor ? 'yes' : explicitlyLimited ? 'no' : 'unknown',
        supportsMouse: capabilityFor(knownInteractive, explicitlyLimited),
        ...(knownInteractive
          ? {
              mouseTracking: 'sgr-1006' as const,
              mouseEncoding: 'sgr-1006' as const,
              mouseProtocols: ['sgr-1006', 'x10'] as const,
            }
          : {}),
        supportsAlternateScreen: alternateScreen,
        imageProtocol: directKitty ? 'kitty' : knownInteractive ? null : 'unknown',
        multiplexer,
        platform,
      }

  // Presence-only forwarding keeps SSH/TMUX/session identifiers out of the
  // capability snapshot while preserving nested-host evidence.
  const capabilityEnvironment: Record<string, string | undefined> = {
    ...(term === 'unknown' ? {} : { TERM: term }),
    ...(colorTerm === undefined ? {} : { COLORTERM: colorTerm }),
    ...(tmux ? { TMUX: 'present' } : {}),
    ...(present(environment, 'SSH_CONNECTION') ? { SSH_CONNECTION: 'present' } : {}),
    ...(present(environment, 'SSH_CLIENT') ? { SSH_CLIENT: 'present' } : {}),
    ...(present(environment, 'SSH_TTY') ? { SSH_TTY: 'present' } : {}),
    ...(windowsTerminal ? { WT_SESSION: 'present' } : {}),
    ...(present(environment, 'VSCODE_INJECTION') ? { VSCODE_INJECTION: 'present' } : {}),
    ...(present(environment, 'VSCODE_PID') ? { VSCODE_PID: 'present' } : {}),
  }
  const capabilities = detectTerminalCapabilities({
    profile,
    generation: 0,
    environment: capabilityEnvironment,
    stdinIsTTY: input.stdin?.isTTY === true,
    rawModeAvailable: typeof input.stdin?.setRawMode === 'function',
  })
  const frozenProfile = Object.freeze({
    ...profile,
    ...(profile.mouseProtocols === undefined
      ? {}
      : { mouseProtocols: Object.freeze([...profile.mouseProtocols]) }),
  })
  return Object.freeze({ profile: frozenProfile, capabilities })
}
