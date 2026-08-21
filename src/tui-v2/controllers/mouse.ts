/**
 * Normalized mouse controller (WP-08g, §6.6).
 *
 * The terminal input owner produces `MousePayload`; this controller is the only
 * layer that decides where a pointer event goes. Components never read stdin.
 * Missing handlers are an explicit degradation, not an exception. Wheel
 * scrolling remains delegated to the existing scrolling controller so its
 * journal/replay semantics stay unchanged.
 */
import type { MousePayload, MouseProtocol, TerminalInputEvent } from '../terminal/input.js'
import type { ScrollingController } from './scrolling.js'

export type MouseRouteTarget = 'selection' | 'search' | 'overlay' | 'cursor' | 'none'

export interface MouseHandler {
  readonly handle: (event: TerminalInputEvent, payload: MousePayload) => boolean | void
}

export interface MouseControllerOptions {
  readonly mode: 'fullscreen' | 'inline'
  readonly enabled: boolean
  readonly supportedProtocols?: readonly MouseProtocol[]
  readonly scrolling?: Pick<ScrollingController, 'handleWheel'>
  readonly selection?: MouseHandler
  readonly search?: MouseHandler
  readonly overlay?: MouseHandler
  readonly cursor?: MouseHandler
  readonly hitTest?: (payload: MousePayload) => MouseRouteTarget
  readonly onDiagnostic?: (diagnostic: { readonly code: string; readonly message: string; readonly mode: 'fullscreen' | 'inline'; readonly protocol?: string }) => void
}

export interface MouseControllerDiagnostics {
  readonly received: number
  readonly consumed: number
  readonly wheels: number
  readonly pointer: number
  readonly unsupported: number
  readonly handlerErrors: number
  readonly mode: 'fullscreen' | 'inline'
  readonly degraded: boolean
}

export interface MouseController {
  readonly handleEvent: (event: TerminalInputEvent) => boolean
  readonly diagnostics: () => MouseControllerDiagnostics
}

function isMouseEvent(event: TerminalInputEvent): event is TerminalInputEvent & { readonly kind: 'mouse'; readonly payload: MousePayload } {
  return event.kind === 'mouse' && event.payload !== null && typeof event.payload === 'object'
}

export function createMouseController(options: MouseControllerOptions): MouseController {
  const counts = {
    received: 0,
    consumed: 0,
    wheels: 0,
    pointer: 0,
    unsupported: 0,
    handlerErrors: 0,
  }
  let degraded = !options.enabled

  const diagnostic = (code: string, message: string, protocol?: string): void => {
    options.onDiagnostic?.({ code, message, mode: options.mode, ...(protocol === undefined ? {} : { protocol }) })
  }

  const unsupported = (message: string, protocol: string): false => {
    counts.unsupported += 1
    degraded = true
    diagnostic('mouse/unsupported', message, protocol)
    return false
  }

  const handlerFor = (target: MouseRouteTarget): MouseHandler | undefined => {
    switch (target) {
      case 'selection': return options.selection
      case 'search': return options.search
      case 'overlay': return options.overlay
      case 'cursor': return options.cursor
      case 'none': return undefined
    }
  }

  return {
    handleEvent(event) {
      if (!isMouseEvent(event)) return false
      counts.received += 1
      const payload = event.payload
      if (!options.enabled) return unsupported('mouse input received while capability is not confirmed', payload.protocol)
      if (options.supportedProtocols !== undefined && !options.supportedProtocols.includes(payload.protocol)) {
        return unsupported(`mouse protocol '${payload.protocol}' is not confirmed by the host`, payload.protocol)
      }

      if (payload.action === 'wheel') {
        counts.wheels += 1
        if ((payload.wheel === 'up' || payload.wheel === 'down') && options.scrolling !== undefined) {
          const consumed = options.scrolling.handleWheel(payload.wheel)
          if (consumed) counts.consumed += 1
          return consumed
        }
        return unsupported(`wheel direction '${String(payload.wheel)}' has no safe route`, payload.protocol)
      }

      counts.pointer += 1
      const target = options.hitTest?.(payload) ?? (payload.action === 'move' ? 'cursor' : 'selection')
      const handler = handlerFor(target)
      if (handler === undefined) {
        return unsupported(`no ${target} handler for ${payload.action}`, payload.protocol)
      }
      try {
        const consumed = handler.handle(event, payload) !== false
        if (consumed) counts.consumed += 1
        return consumed
      } catch {
        counts.handlerErrors += 1
        diagnostic('mouse/handler-error', `mouse ${target} handler failed`, payload.protocol)
        return false
      }
    },
    diagnostics: () => ({ ...counts, mode: options.mode, degraded }),
  }
}
