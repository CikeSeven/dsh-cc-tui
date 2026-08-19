/**
 * Slash-command controller (WP-05, plan §5.1: components never touch the
 * channel; the command dispatch skeleton lives here).
 *
 * Routing (v1 Chat.tsx parity):
 *
 *   working + Enter            → steer(trimmed) — EXCEPT `/btw`, which still
 *                                runs as an external command while working
 *   idle + "/new"              → replay.newSession()
 *   idle + "/clear"            → replay.clear()
 *   idle + "/resume"           → open the session-browser overlay (journaled
 *                                overlay/open; the picker itself is WP-08)
 *   idle + "/resume <id>"      → replay.resume(id)
 *   idle + "/workspace …"      → no subcommand: pushLocal usage; a provider
 *                                subcommand (name/alias match) runs
 *                                runWorkspaceCommand — choices degrade to a
 *                                pushLocal list (WP-08 owns the picker),
 *                                target switches the workspace
 *   idle + external command    → runExternalCommand (registry truth):
 *                                undefined → command-not-found notification,
 *                                '' → silent, text → notify
 *   idle + skill / unknown "/" → the whole line falls through to the model
 *   idle + plain text          → submit
 *
 * `workspace resume/rename/open` are WP-08 surface: registered as TODO and
 * treated as unknown subcommands here.
 *
 * Async command operations carry a monotonic token; a newer submission
 * supersedes a stale in-flight one (its notifications are dropped).
 *
 * Dependency rule (§4.3): model + dsh-adapter types only; no stdout, no ANSI,
 * no component internals — and no i18n (the command-name parse is a local
 * regex; user-facing strings are English fallbacks like the channel's).
 */

import type { AppEvent } from '../model/events.js'
import type { EventMeta, OverlayState, SerializableError } from '../model/schema.js'
import type { LocalCommand } from '../../commands.js'
import type {
  TuiWorkspaceCommand,
  TuiWorkspaceCommandResult,
  TuiWorkspaceTarget,
} from '../../dsh-adapter/workspaces.js'
import type { ReplayController } from './replay.js'

/** Channel surface the command router needs (structural subset). */
export interface CommandChannel {
  /** True while the assistant is working (submit routes to steer). */
  readonly working: boolean
  /** Effective slash commands (locals + plugin-registered externals). */
  readonly commandList: readonly LocalCommand[]
  /** Plugin/external command dispatch; undefined = the registry has no such
   *  command, '' = handled silently, text = handled, show as a notice. */
  runExternalCommand(name: string, rawInput: string): Promise<string | undefined>
  /** Workspace provider subcommands (name/aliases/description). */
  workspaceCommands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[]
  runWorkspaceCommand(name: string, input: string): Promise<TuiWorkspaceCommandResult | undefined>
  switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean>
  /** Multi-line local report rows (`local` + `local-output`). */
  pushLocal(title: string, lines: readonly string[]): void
}

export type SubmittedTextOutcome = 'empty' | 'steered' | 'submitted' | 'command'

export interface CommandsControllerOptions {
  /** Outgoing event journal (coordinator dispatch pipeline). */
  readonly dispatch: (event: AppEvent) => void
  /** Allocate the journal event envelope; controller sourceSeqs are `commands-N`. */
  readonly nextMeta: (sourceSeq: string) => EventMeta
  readonly channel: CommandChannel
  /** Session-navigation commands (/new, /clear, /resume) delegate here. */
  readonly replay: Pick<ReplayController, 'newSession' | 'resume' | 'clear'>
  /** Plain-model submission sink (adapter commands.submit / .steer). */
  readonly submitToModel: (text: string) => void
  readonly steerToModel: (text: string) => void
  /** Dock-level notification sink. */
  readonly notify: (text: string, options?: { color?: 'error' | 'warning' | 'success' }) => void
}

export interface CommandsControllerDiagnostics {
  readonly submitted: number
  readonly steered: number
  readonly empties: number
  readonly commands: number
  readonly externalCommands: number
  readonly workspaceCommands: number
  readonly unknownCommands: number
  readonly overlaysOpened: number
  readonly superseded: number
}

export interface CommandsController {
  /** Route one submitted editor line. Never throws. */
  readonly handleSubmittedText: (text: string) => SubmittedTextOutcome
  readonly diagnostics: () => CommandsControllerDiagnostics
}

/** `/^\/([a-z][a-z0-9_-]*)(?=$|\s)/` — kept local so controllers stay i18n-free
 *  (src/commands.ts imports the i18n module). */
function parseSlashName(line: string): { name: string; rawInput: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|\s)/.exec(line)
  if (match === null) return undefined
  return { name: match[1], rawInput: line.slice(match[0].length).trim() }
}

function findCommand(list: readonly LocalCommand[], name: string): LocalCommand | undefined {
  return list.find((command) => command.name === name)
}

export function createCommandsController(options: CommandsControllerOptions): CommandsController {
  let journalSeq = 0
  /** Monotonic token: a newer async op supersedes every earlier one. */
  let opToken = 0
  /** Per-overlayId journal revision (overlay/open requires monotonic revisions). */
  const overlayRevisions = new Map<string, number>()
  const counts = {
    submitted: 0,
    steered: 0,
    empties: 0,
    commands: 0,
    externalCommands: 0,
    workspaceCommands: 0,
    unknownCommands: 0,
    overlaysOpened: 0,
    superseded: 0,
  }

  const journal = (body: Pick<AppEvent, 'type'> & Record<string, unknown>): void => {
    journalSeq += 1
    options.dispatch({ ...options.nextMeta(`commands-${journalSeq}`), ...body } as AppEvent)
  }

  const journalError = (code: string, message: string): void => {
    const error: SerializableError = { code, message, recoverable: true }
    journal({ type: 'app/error', error })
  }

  const journalOverlayOpen = (overlayId: string, payload: OverlayState['payload']): void => {
    const revision = (overlayRevisions.get(overlayId) ?? 0) + 1
    overlayRevisions.set(overlayId, revision)
    counts.overlaysOpened += 1
    journal({
      type: 'overlay/open',
      overlay: {
        overlayId,
        revision,
        anchor: 'center',
        visible: true,
        captureInput: true,
        nonCapturing: false,
        payload,
      },
    })
  }

  const superseded = (token: number): boolean => {
    if (token === opToken) return false
    counts.superseded += 1
    return true
  }

  const runExternal = async (name: string, rawInput: string): Promise<void> => {
    counts.externalCommands += 1
    const token = ++opToken
    try {
      const result = await options.channel.runExternalCommand(name, rawInput)
      if (superseded(token)) return
      if (result === undefined) {
        options.notify(`Command not found: /${name}`, { color: 'error' })
      } else if (result !== '') {
        options.notify(result)
      }
    } catch (error) {
      if (superseded(token)) return
      journalError('external-command-failed', `/${name}: ${String(error)}`)
      options.notify(`Command failed: /${name}`, { color: 'error' })
    }
  }

  const runWorkspace = async (name: string, input: string): Promise<void> => {
    counts.workspaceCommands += 1
    const token = ++opToken
    try {
      const result = await options.channel.runWorkspaceCommand(name, input)
      if (superseded(token)) return
      if (result === undefined) {
        options.notify(`Unknown workspace command: ${name}`, { color: 'error' })
        return
      }
      if (result.kind === 'choices') {
        // WP-08 owns the interactive picker; WP-05 degrades it to a local list.
        options.channel.pushLocal(result.title, result.choices.map((choice) => choice.label))
        return
      }
      const ok = await options.channel.switchWorkspace(result.target)
      if (superseded(token)) return
      if (!ok) options.notify('Failed to switch workspace', { color: 'error' })
    } catch (error) {
      if (superseded(token)) return
      journalError('workspace-command-failed', `workspace ${name}: ${String(error)}`)
      options.notify(`Workspace command failed: ${name}`, { color: 'error' })
    }
  }

  const handleWorkspace = (rawInput: string): void => {
    const space = rawInput.search(/\s/)
    const sub = (space === -1 ? rawInput : rawInput.slice(0, space)).trim()
    const rest = space === -1 ? '' : rawInput.slice(space + 1).trim()
    if (sub === '') {
      const commands = options.channel.workspaceCommands()
      options.channel.pushLocal('/workspace', [
        'Usage: /workspace <command> [input]',
        ...commands.map((command) => `  ${command.name} — ${command.description}`),
      ])
      return
    }
    // TODO(WP-08): workspace resume/rename/open get dedicated flows; they are
    // unknown subcommands here.
    const provider = options.channel
      .workspaceCommands()
      .find((command) => command.name === sub || (command.aliases ?? []).includes(sub))
    if (provider === undefined) {
      counts.unknownCommands += 1
      options.notify(`Unknown workspace command: ${sub}`, { color: 'error' })
      return
    }
    void runWorkspace(provider.name, rest)
  }

  const handleSlash = (text: string, parsed: { name: string; rawInput: string }): SubmittedTextOutcome => {
    const { name, rawInput } = parsed
    if (name === 'new') {
      counts.commands += 1
      void options.replay.newSession()
      return 'command'
    }
    if (name === 'clear') {
      counts.commands += 1
      options.replay.clear()
      return 'command'
    }
    if (name === 'resume') {
      counts.commands += 1
      if (rawInput === '') {
        journalOverlayOpen('session-browser', { kind: 'session-browser' })
      } else {
        void options.replay.resume(rawInput)
      }
      return 'command'
    }
    if (name === 'workspace') {
      counts.commands += 1
      handleWorkspace(rawInput)
      return 'command'
    }
    const entry = findCommand(options.channel.commandList, name)
    if (entry !== undefined && entry.external === true) {
      counts.commands += 1
      void runExternal(name, rawInput)
      return 'command'
    }
    if (entry !== undefined && entry.skill === true) {
      // Skill entries are completion-only: the whole line falls through to
      // the model, where the skill pre-step hook injects the body.
      counts.submitted += 1
      options.submitToModel(text)
      return 'submitted'
    }
    if (entry === undefined) {
      // Unknown slash command: v1 sends the whole line to the model.
      counts.unknownCommands += 1
      counts.submitted += 1
      options.submitToModel(text)
      return 'submitted'
    }
    // A built-in local command WP-05 does not route yet: keep v1 behaviour of
    // never leaking a bare local command name to the model by treating it as
    // not-found surface (WP-08 completes the routing table).
    counts.unknownCommands += 1
    options.notify(`Unsupported command in this UI: /${name}`, { color: 'warning' })
    return 'command'
  }

  return {
    handleSubmittedText(text) {
      const trimmed = text.trim()
      if (trimmed === '') {
        counts.empties += 1
        return 'empty'
      }
      if (options.channel.working) {
        // While working, Enter steers — except /btw, which still dispatches.
        const parsed = trimmed.startsWith('/') ? parseSlashName(trimmed) : undefined
        if (parsed !== undefined && parsed.name === 'btw') {
          const entry = findCommand(options.channel.commandList, 'btw')
          if (entry !== undefined && entry.external === true) {
            counts.commands += 1
            void runExternal('btw', parsed.rawInput)
            return 'command'
          }
        }
        counts.steered += 1
        options.steerToModel(trimmed)
        return 'steered'
      }
      if (trimmed.startsWith('/')) {
        const parsed = parseSlashName(trimmed)
        if (parsed !== undefined) return handleSlash(trimmed, parsed)
      }
      counts.submitted += 1
      options.submitToModel(text)
      return 'submitted'
    },

    diagnostics: () => ({ ...counts }),
  }
}
