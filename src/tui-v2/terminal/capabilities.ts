/**
 * Canonical terminal capability registry/detector (WP-08g, plan §§5.4/5.6/6.6).
 *
 * This module is deliberately independent of the writer and stdin owner.  It
 * consumes an already parsed `TerminalProfile`, allowlisted environment
 * presence bits, and parsed query responses.  It never stores raw environment
 * values or response/payload bytes.  Unknown and timed-out evidence remains
 * conservative; callers must not turn this snapshot into an unsafe sequence
 * without an explicit `support === 'yes'` decision.
 */
import { createHash } from 'node:crypto'

import type { QueryKind, QueryResponse } from './query.js'
import type { Capability, TerminalProfile } from './profile.js'
import type { MouseTrackingMode } from '../renderer/frame.js'

export const CAPABILITY_SNAPSHOT_VERSION = 1 as const

export type CapabilityName =
  | 'alternateScreen'
  | 'rawInput'
  | 'bracketedPaste'
  | 'mouse'
  | 'focusReporting'
  | 'kittyKeyboard'
  | 'osc52'
  | 'kittyImage'
  | 'iterm2Image'
  | 'syncOutput'
  | 'hyperlinks'
  | 'unicodeWidth'
  | 'conpty'
  | 'ssh'
  | 'tmux'
  | 'vscode'

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  'alternateScreen',
  'rawInput',
  'bracketedPaste',
  'mouse',
  'focusReporting',
  'kittyKeyboard',
  'osc52',
  'kittyImage',
  'iterm2Image',
  'syncOutput',
  'hyperlinks',
  'unicodeWidth',
  'conpty',
  'ssh',
  'tmux',
  'vscode',
]

export type CapabilitySource = 'default' | 'profile' | 'environment' | 'query' | 'policy'
export type CapabilityReason =
  | 'profile-confirmed'
  | 'profile-denied'
  | 'profile-unknown'
  | 'environment-confirmed'
  | 'query-confirmed'
  | 'query-denied'
  | 'query-timeout'
  | 'query-error'
  | 'query-generation-mismatch'
  | 'query-token-mismatch'
  | 'policy-confirmed'
  | 'policy-denied'
  | 'not-applicable'
  | 'not-a-tty'
  | 'unknown-host'

export interface CapabilityEvidence {
  readonly support: Capability
  readonly reason: CapabilityReason
  readonly source: CapabilitySource
}

export type HostKind = 'kitty' | 'iterm2' | 'windows-terminal' | 'conpty' | 'ssh' | 'tmux' | 'vscode' | 'unknown'

export interface CapabilityMouseSnapshot {
  readonly enabled: Capability
  readonly tracking: MouseTrackingMode
  readonly encoding: 'sgr-1006' | 'urxvt-1015' | 'x10' | 'none'
  readonly supportedProtocols: readonly ('sgr-1006' | 'urxvt-1015' | 'x10')[]
  readonly reason: CapabilityReason
}

export interface CapabilityQueryAudit {
  readonly kind: QueryKind
  readonly tokenId: string
  readonly generation: number
  readonly status: 'accepted' | 'dropped'
  readonly reason?: CapabilityReason
  /** Shape only; response values and raw bytes never enter a snapshot. */
  readonly valueShape?: 'object' | 'unknown'
}

export interface TerminalCapabilitySnapshot {
  readonly schemaVersion: typeof CAPABILITY_SNAPSHOT_VERSION
  readonly profileId: string
  readonly generation: number
  readonly host: HostKind
  readonly multiplexer: TerminalProfile['multiplexer']
  readonly term: string
  readonly geometry: { readonly columns: number; readonly rows: number }
  readonly unicode: { readonly ambiguousWidth: 1 | 2 | 'unknown'; readonly level: number | 'unknown' }
  readonly capabilities: Readonly<Record<CapabilityName, CapabilityEvidence>>
  readonly mouse: CapabilityMouseSnapshot
  readonly queries: {
    readonly accepted: readonly CapabilityQueryAudit[]
    readonly dropped: readonly CapabilityQueryAudit[]
  }
  readonly conservative: boolean
  readonly deferred: readonly ('pty' | 'real-host')[]
}

export interface CapabilityQueryObservation {
  readonly token: Pick<QueryResponse, 'tokenId' | 'generation' | 'kind'>
  readonly response?: QueryResponse
  readonly status: 'response' | 'timeout' | 'error'
}

export interface CapabilityPolicy {
  readonly osc52?: Capability
  readonly rawInput?: Capability
  readonly allowQueries?: boolean
}

export interface CapabilityDetectionInput {
  readonly profile: TerminalProfile
  readonly generation: number
  /** Only presence/value shape is inspected for these allowlisted keys. */
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly stdinIsTTY?: boolean
  readonly rawModeAvailable?: boolean
  readonly policy?: CapabilityPolicy
  readonly queries?: readonly CapabilityQueryObservation[]
}

export interface CapabilityRegistry {
  readonly snapshot: () => TerminalCapabilitySnapshot
  readonly refresh: (input: CapabilityDetectionInput) => CapabilityRefreshResult
  readonly transaction: (input: CapabilityDetectionInput) => CapabilityTransaction
}

export interface CapabilityRefreshResult {
  readonly status: 'committed' | 'stale'
  readonly snapshot: TerminalCapabilitySnapshot
  readonly reason?: 'generation-not-newer'
}

export interface CapabilityTransaction {
  readonly generation: number
  readonly commit: () => CapabilityRefreshResult
  readonly abort: () => void
}

const ALLOWLISTED_ENV = new Set([
  'TERM',
  'COLORTERM',
  'TMUX',
  'SSH_CONNECTION',
  'SSH_CLIENT',
  'SSH_TTY',
  'WT_SESSION',
  'ConEmuANSI',
  'TERM_PROGRAM',
  'VSCODE_INJECTION',
  'VSCODE_PID',
])

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

function environmentPresence(environment: CapabilityDetectionInput['environment']): Record<string, boolean> {
  const presence: Record<string, boolean> = {}
  for (const key of ALLOWLISTED_ENV) {
    // Do not copy the value: the detector only needs a boolean presence bit.
    presence[key] = typeof environment?.[key] === 'string' && environment[key] !== ''
  }
  return presence
}

function detectHost(profile: TerminalProfile, environment: CapabilityDetectionInput['environment']): HostKind {
  const env = environmentPresence(environment)
  // The primary host label is singular, but the capability evidence below
  // records SSH and multiplexer presence independently so nested tmux-over-SSH
  // sessions do not lose either fact.
  if (env.TMUX || profile.multiplexer === 'tmux') return 'tmux'
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || profile.id === 'ssh') return 'ssh'
  if (env.VSCODE_INJECTION || env.VSCODE_PID || environment?.TERM_PROGRAM === 'vscode' || profile.family === 'vscode') return 'vscode'
  if (profile.family === 'kitty' || environment?.TERM_PROGRAM === 'kitty') return 'kitty'
  if (profile.family === 'iterm2' || environment?.TERM_PROGRAM === 'iTerm.app' || environment?.TERM_PROGRAM === 'iTerm2') return 'iterm2'
  if (profile.family === 'windows-terminal' || env.WT_SESSION) return 'windows-terminal'
  if (profile.family === 'conpty') return 'conpty'
  return 'unknown'
}

function profileEvidence(value: Capability, policy: Capability | undefined = undefined): CapabilityEvidence {
  if (policy === 'no') return { support: 'no', reason: 'policy-denied', source: 'policy' }
  if (policy === 'yes' && value !== 'no') return { support: 'yes', reason: 'policy-confirmed', source: 'policy' }
  return {
    support: value,
    reason: value === 'yes' ? 'profile-confirmed' : value === 'no' ? 'profile-denied' : 'profile-unknown',
    source: 'profile',
  }
}

function presenceEvidence(present: boolean, host: HostKind): CapabilityEvidence {
  if (present) return { support: 'yes', reason: 'environment-confirmed', source: 'environment' }
  if (host === 'unknown') return { support: 'unknown', reason: 'unknown-host', source: 'default' }
  return { support: 'no', reason: 'not-applicable', source: 'environment' }
}

function queryValueShape(response: QueryResponse): 'object' | 'unknown' {
  return response.value !== null && typeof response.value === 'object' && !Array.isArray(response.value) ? 'object' : 'unknown'
}

function queryValueValid(response: QueryResponse): boolean {
  const value = response.value as Record<string, unknown> | null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  switch (response.kind) {
    case 'kitty-keyboard':
      return Number.isInteger(value.flags) && (value.flags as number) >= 0 && (value.flags as number) <= 15
    case 'focus':
      return Number.isInteger(value.mode) && (value.mode as number) >= 0 && (value.mode as number) <= 4 && typeof value.enabled === 'boolean' && typeof value.recognized === 'boolean'
    case 'cursor':
      return Number.isInteger(value.row) && Number.isInteger(value.column)
    case 'size':
      return Number.isInteger(value.rows) && Number.isInteger(value.columns)
    case 'cell-size':
      return Number.isInteger(value.heightPixels) && Number.isInteger(value.widthPixels)
    case 'version':
      return typeof value.version === 'string'
    case 'color':
      return typeof value.color === 'string'
    case 'capability':
      return Array.isArray(value.params) && value.params.every((item) => Number.isInteger(item))
  }
}

function safeTokenId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/u.test(value)) return '<redacted-token>'
  return value
}

function validMouseConfiguration(profile: TerminalProfile): boolean {
  if (profile.supportsMouse !== 'yes') return false
  const tracking = profile.mouseTracking ?? 'sgr-1006'
  const encoding = profile.mouseEncoding ?? (tracking === 'urxvt-1015' ? 'urxvt-1015' : tracking === 'x10-1000' ? 'x10' : 'sgr-1006')
  const protocols = profile.mouseProtocols ?? ['sgr-1006', 'urxvt-1015', 'x10']
  if (tracking === 'off') return false
  if (tracking === 'x10-1000') return encoding === 'x10' && protocols.includes('x10')
  if (encoding === 'x10') return false
  return (encoding === 'sgr-1006' || encoding === 'urxvt-1015') && protocols.includes(encoding)
}

function queryAudit(observation: CapabilityQueryObservation, generation: number): { audit: CapabilityQueryAudit; accepted: boolean } {
  const base = {
    kind: observation.token.kind,
    tokenId: safeTokenId(observation.token.tokenId),
    generation: observation.token.generation,
  }
  if (observation.status !== 'response' || observation.response === undefined) {
    return {
      accepted: false,
      audit: { ...base, status: 'dropped', reason: observation.status === 'timeout' ? 'query-timeout' : 'query-error' },
    }
  }
  const response = observation.response
  if (observation.token.generation !== generation || response.generation !== generation) {
    return {
      accepted: false,
      audit: { ...base, status: 'dropped', reason: 'query-generation-mismatch' },
    }
  }
  if (response.tokenId !== observation.token.tokenId || response.kind !== observation.token.kind) {
    return {
      accepted: false,
      audit: { ...base, status: 'dropped', reason: 'query-token-mismatch' },
    }
  }
  if (!queryValueValid(response)) {
    return {
      accepted: false,
      audit: { ...base, status: 'dropped', reason: 'query-error', valueShape: queryValueShape(response) },
    }
  }
  return {
    accepted: true,
    audit: { ...base, status: 'accepted', valueShape: queryValueShape(response) },
  }
}

function applyQueryEvidence(
  capabilities: Record<CapabilityName, CapabilityEvidence>,
  observation: CapabilityQueryObservation,
  accepted: boolean,
): void {
  if (!accepted || observation.response === undefined) return
  const response = observation.response
  const querySupport = (name: CapabilityName, support: Capability, reason: CapabilityReason = 'query-confirmed'): void => {
    capabilities[name] = { support, reason, source: 'query' }
  }
  switch (response.kind) {
    case 'kitty-keyboard': {
      const value = response.value as { flags?: unknown } | null
      if (value !== null && value !== undefined && Number.isInteger(value.flags) && (value.flags as number) >= 0) {
        querySupport('kittyKeyboard', 'yes')
      }
      break
    }
    case 'focus': {
      const value = response.value as { enabled?: unknown; recognized?: unknown } | null
      if (value !== null && value !== undefined && value.recognized === true) {
        querySupport('focusReporting', value.enabled === true ? 'yes' : 'no', value.enabled === true ? 'query-confirmed' : 'query-denied')
      }
      break
    }
    case 'color':
      querySupport('hyperlinks', capabilities.hyperlinks.support)
      break
    default:
      // Other reports provide geometry/version evidence to the caller but do
      // not prove a control mode. Never infer a dangerous feature from DA.
      break
  }
}

function applyQueryFailure(
  capabilities: Record<CapabilityName, CapabilityEvidence>,
  observation: CapabilityQueryObservation,
  reason: CapabilityReason | undefined,
): void {
  if (reason === undefined || reason === 'policy-denied') return
  const querySupport = (name: CapabilityName): void => {
    capabilities[name] = { support: 'no', reason, source: 'query' }
  }
  switch (observation.token.kind) {
    case 'kitty-keyboard':
      querySupport('kittyKeyboard')
      break
    case 'focus':
      querySupport('focusReporting')
      break
    default:
      // A generic capability/geometry query cannot prove a control mode, so
      // failure does not alter unrelated profile evidence.
      break
  }
}

function normalizeSnapshot(input: CapabilityDetectionInput): TerminalCapabilitySnapshot {
  if (!Number.isInteger(input.generation) || input.generation < 0) throw new RangeError('capability generation must be a non-negative integer')
  const profile = input.profile
  const host = detectHost(profile, input.environment)
  const env = environmentPresence(input.environment)
  const tty = input.stdinIsTTY
  const policy = input.policy ?? {}
  const capabilities = {} as Record<CapabilityName, CapabilityEvidence>

  capabilities.alternateScreen = profileEvidence(profile.supportsAlternateScreen)
  capabilities.rawInput = policy.rawInput === 'no'
    ? { support: 'no', reason: 'policy-denied', source: 'policy' }
    : policy.rawInput === 'yes'
      ? { support: 'yes', reason: 'policy-confirmed', source: 'policy' }
      : tty === false || input.rawModeAvailable === false
        ? { support: 'no', reason: tty === false ? 'not-a-tty' : 'policy-denied', source: 'policy' }
        : tty === true
          ? { support: 'yes', reason: 'environment-confirmed', source: 'environment' }
          : profileEvidence('unknown')
  capabilities.bracketedPaste = profileEvidence(profile.supportsBracketedPaste)
  capabilities.mouse = profile.supportsMouse === 'yes' && !validMouseConfiguration(profile)
    ? { support: 'no', reason: 'profile-denied', source: 'profile' }
    : profileEvidence(profile.supportsMouse)
  capabilities.focusReporting = profileEvidence(profile.supportsFocusReporting)
  capabilities.kittyKeyboard = profileEvidence(profile.supportsKittyKeyboard)
  capabilities.osc52 = profileEvidence(profile.supportsOsc52, policy.osc52)
  capabilities.kittyImage = profileEvidence(profile.imageProtocol === 'kitty' ? 'yes' : profile.imageProtocol === 'unknown' ? 'unknown' : 'no')
  capabilities.iterm2Image = profileEvidence(profile.imageProtocol === 'iterm2' ? 'yes' : profile.imageProtocol === 'unknown' ? 'unknown' : 'no')
  capabilities.syncOutput = profileEvidence(profile.supportsSyncOutput)
  capabilities.hyperlinks = profileEvidence(profile.supportsOsc8Hyperlinks)
  capabilities.unicodeWidth = profileEvidence(profile.ambiguousWidth === 'unknown' ? 'unknown' : 'yes')
  capabilities.conpty = presenceEvidence(profile.family === 'conpty', host)
  capabilities.ssh = presenceEvidence(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || profile.id === 'ssh', host)
  capabilities.tmux = presenceEvidence(env.TMUX || profile.multiplexer === 'tmux', host)
  capabilities.vscode = presenceEvidence(env.VSCODE_INJECTION || env.VSCODE_PID || input.environment?.TERM_PROGRAM === 'vscode' || profile.family === 'vscode', host)

  const configuredMouse = profile.mouseTracking ?? (profile.supportsMouse === 'yes' ? 'sgr-1006' : 'off')
  const configuredEncoding = profile.mouseEncoding ?? (configuredMouse === 'urxvt-1015' ? 'urxvt-1015' : configuredMouse === 'x10-1000' ? 'x10' : 'sgr-1006')
  const mouseEnabled = capabilities.mouse.support === 'yes' && configuredMouse !== 'off'
  const supportedProtocols = capabilities.mouse.support === 'yes'
    ? (profile.mouseProtocols ?? ['sgr-1006', 'urxvt-1015', 'x10'])
    : []

  const accepted: CapabilityQueryAudit[] = []
  const dropped: CapabilityQueryAudit[] = []
  const seenQueryTokens = new Set<string>()
  const confirmedQueryKinds = new Set<QueryKind>()
  for (const observation of input.queries ?? []) {
    const tokenKey = `${observation.token.kind}\u0000${observation.token.tokenId}\u0000${observation.token.generation}`
    if (seenQueryTokens.has(tokenKey)) {
      dropped.push({ kind: observation.token.kind, tokenId: safeTokenId(observation.token.tokenId), generation: observation.token.generation, status: 'dropped', reason: 'query-token-mismatch' })
      if (!confirmedQueryKinds.has(observation.token.kind)) applyQueryFailure(capabilities, observation, 'query-token-mismatch')
      continue
    }
    seenQueryTokens.add(tokenKey)
    const result = queryAudit(observation, input.generation)
    if (policy.allowQueries === false) {
      dropped.push({
        kind: result.audit.kind,
        tokenId: result.audit.tokenId,
        generation: result.audit.generation,
        status: 'dropped',
        reason: 'policy-denied',
      })
      continue
    }
    ;(result.accepted ? accepted : dropped).push(result.audit)
    if (result.accepted) {
      confirmedQueryKinds.add(observation.token.kind)
      applyQueryEvidence(capabilities, observation, true)
    } else if (!confirmedQueryKinds.has(observation.token.kind)) {
      applyQueryFailure(capabilities, observation, result.audit.reason)
    }
  }

  const conservative = host === 'unknown' || Object.values(capabilities).some((entry) => entry.support === 'unknown')
  const deferred: ('pty' | 'real-host')[] = ['pty', 'real-host']
  return freezeDeep({
    schemaVersion: CAPABILITY_SNAPSHOT_VERSION,
    profileId: profile.id,
    generation: input.generation,
    host,
    multiplexer: profile.multiplexer,
    term: profile.term,
    geometry: { columns: profile.columns, rows: profile.rows },
    unicode: { ambiguousWidth: profile.ambiguousWidth, level: profile.unicodeLevel },
    capabilities,
    mouse: {
      enabled: mouseEnabled ? 'yes' : capabilities.mouse.support,
      tracking: mouseEnabled ? configuredMouse : 'off',
      encoding: mouseEnabled ? configuredEncoding : 'none',
      supportedProtocols,
      reason: capabilities.mouse.reason,
    },
    queries: { accepted, dropped },
    conservative,
    deferred,
  })
}

/** Normalize a profile/environment/query batch into one immutable snapshot. */
export function detectTerminalCapabilities(input: CapabilityDetectionInput): TerminalCapabilitySnapshot {
  return normalizeSnapshot(input)
}

/** Canonical JSON for artifacts/traces; keys are sorted and no raw source is retained. */
export function canonicalCapabilitySnapshot(snapshot: TerminalCapabilitySnapshot): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sort(item)]))
    }
    return value
  }
  return JSON.stringify(sort(snapshot))
}

export function hashCapabilitySnapshot(snapshot: TerminalCapabilitySnapshot): string {
  return createHash('sha256').update(canonicalCapabilitySnapshot(snapshot), 'utf8').digest('hex')
}

/**
 * Process-local registry. `refresh()` is the only publication point; stale
 * generations are rejected without replacing the immutable current snapshot.
 */
export function createCapabilityRegistry(initial: CapabilityDetectionInput): CapabilityRegistry {
  let current = detectTerminalCapabilities(initial)
  const refresh = (input: CapabilityDetectionInput): CapabilityRefreshResult => {
    if (input.generation <= current.generation) return { status: 'stale', snapshot: current, reason: 'generation-not-newer' }
    current = detectTerminalCapabilities(input)
    return { status: 'committed', snapshot: current }
  }
  return {
    snapshot: () => current,
    refresh,
    transaction(input) {
      let closed = false
      return {
        generation: input.generation,
        commit: () => {
          if (closed) return { status: 'stale', snapshot: current, reason: 'generation-not-newer' }
          closed = true
          return refresh(input)
        },
        abort: () => { closed = true },
      }
    },
  }
}

export function capabilitySupport(snapshot: TerminalCapabilitySnapshot, name: CapabilityName): boolean {
  return snapshot.capabilities[name].support === 'yes'
}
