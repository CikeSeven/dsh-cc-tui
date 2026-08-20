/**
 * Slash-command controller (WP-08c).
 *
 * Session mutations stay in ReplayController. Interactive commands delegate to
 * narrow utility-overlay actions, so this controller never publishes ad-hoc
 * overlay payloads or owns callbacks. Bare `/resume` opens the generic picker;
 * direct `/resume <id>` keeps the replay boundary.
 */
import type { LocalCommand } from '../../commands.js'
import type {
  TuiWorkspaceCommand,
  TuiWorkspaceCommandResult,
  TuiWorkspaceTarget,
} from '../../dsh-adapter/workspaces.js'
import type { AppEvent } from '../model/events.js'
import type { EventMeta, SerializableError } from '../model/schema.js'
import type { ReplayController } from './replay.js'

export interface CommandChannel {
  readonly working: boolean
  readonly commandList: readonly LocalCommand[]
  runExternalCommand(name: string, rawInput: string): Promise<string | undefined>
  workspaceCommands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[]
  runWorkspaceCommand(name: string, input: string): Promise<TuiWorkspaceCommandResult | undefined>
  switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean>
  pushLocal(title: string, lines: readonly string[]): void
}

export interface CommandOverlayActions {
  readonly openResumePicker: (onSelect: (id: string) => void) => boolean
  readonly openHelp: (query: string) => boolean
  readonly openHistorySearch: (query: string) => boolean
  readonly openTranscriptSearch: (query: string) => boolean
}

export type SubmittedTextOutcome = 'empty' | 'steered' | 'submitted' | 'command'

export interface CommandsControllerOptions {
  readonly dispatch: (event: AppEvent) => void
  readonly nextMeta: (sourceSeq: string) => EventMeta
  readonly channel: CommandChannel
  readonly replay: Pick<ReplayController, 'newSession' | 'resume' | 'clear'>
  readonly overlays: CommandOverlayActions
  readonly submitToModel: (text: string) => void
  readonly steerToModel: (text: string) => void
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
  readonly handleSubmittedText: (text: string) => SubmittedTextOutcome
  readonly diagnostics: () => CommandsControllerDiagnostics
}

function parseSlashName(line: string): { name: string; rawInput: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|\s)/.exec(line)
  if (match === null) return undefined
  return { name: match[1] as string, rawInput: line.slice(match[0].length).trim() }
}

function findCommand(list: readonly LocalCommand[], name: string): LocalCommand | undefined {
  return list.find((command) => command.name === name)
}

export function createCommandsController(options: CommandsControllerOptions): CommandsController {
  let journalSeq = 0
  let opToken = 0
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

  const superseded = (token: number): boolean => {
    if (token === opToken) return false
    counts.superseded += 1
    return true
  }

  const noteOverlay = (opened: boolean): void => {
    if (opened) {
      counts.overlaysOpened += 1
    } else {
      options.notify('Close the active business dialog before opening this view', { color: 'warning' })
    }
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
        // Workspace switching is outside WP-08c's picker migration; retain the
        // explicit local list rather than inventing a partial workspace flow.
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
        noteOverlay(options.overlays.openResumePicker((id) => {
          void options.replay.resume(id)
        }))
      } else {
        void options.replay.resume(rawInput)
      }
      return 'command'
    }
    if (name === 'help') {
      counts.commands += 1
      noteOverlay(options.overlays.openHelp(rawInput))
      return 'command'
    }
    if (name === 'history') {
      counts.commands += 1
      noteOverlay(options.overlays.openHistorySearch(rawInput))
      return 'command'
    }
    if (name === 'search') {
      counts.commands += 1
      noteOverlay(options.overlays.openTranscriptSearch(rawInput))
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
      counts.submitted += 1
      options.submitToModel(text)
      return 'submitted'
    }
    if (entry === undefined) {
      counts.unknownCommands += 1
      counts.submitted += 1
      options.submitToModel(text)
      return 'submitted'
    }
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
        const parsed = trimmed.startsWith('/') ? parseSlashName(trimmed) : undefined
        if (parsed !== undefined && (
          parsed.name === 'help' || parsed.name === 'history' || parsed.name === 'search'
        )) return handleSlash(trimmed, parsed)
        if (parsed?.name === 'btw') {
          const entry = findCommand(options.channel.commandList, 'btw')
          if (entry?.external === true) {
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
