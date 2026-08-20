/**
 * tui-v2 renderer frame/cell contracts (WP-02, plan §5.5).
 *
 * CONTRACTS ONLY — no implementation lives here. Frame building, diffing and
 * the screen backend land in later work packages (WP-03+). This file exists
 * so model/testkit/terminal code can share one immutable vocabulary.
 *
 * Dependency rule (§4.3): renderer may `import type` from model only; nothing
 * here imports terminal or node modules. `FrameLayer` is defined here (not in
 * model/schema.ts) because it is part of the frame contract.
 */

export interface TerminalCell {
  readonly grapheme: string
  readonly width: 0 | 1 | 2
  readonly styleId: number
  readonly hyperlinkId?: number
}

export interface StyleDescriptor {
  readonly id: number
  readonly foreground: string | null
  readonly background: string | null
  readonly bold: boolean
  readonly dim: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly inverse: boolean
  readonly strike: boolean
}
export interface HyperlinkDescriptor { readonly id: number; readonly uri: string; readonly params?: string }
export interface FrameResources {
  readonly styles: readonly StyleDescriptor[]
  readonly hyperlinks: readonly HyperlinkDescriptor[]
}
export interface TerminalModeSnapshot {
  readonly alternateScreen: boolean
  readonly rawInput: boolean
  readonly mouse: MouseTrackingMode
  readonly bracketedPaste: boolean
  readonly syncOutput: boolean
  readonly autowrap: boolean
  readonly wrapPending: boolean
  readonly scrollRegion: { readonly top: number; readonly bottom: number }
  readonly cursorStyle: 'block' | 'underline' | 'bar' | 'unknown'
  readonly cursorVisible: boolean
  readonly kittyKeyboard: boolean
  readonly modifyOtherKeys: boolean
  readonly focusReporting: boolean
  readonly windowsDec9001: boolean
  readonly osc133: boolean
  readonly title: string | null
  readonly progress: { readonly state: 'none' | 'normal' | 'error' | 'paused'; readonly value?: number }
}

export type MouseTrackingMode = 'off' | 'x10-1000' | 'normal-1002' | 'button-1002' | 'any-1003' | 'sgr-1006' | 'urxvt-1015'

export interface FrameLayer { readonly id: string; readonly z: number; readonly revision: number; readonly clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }

export interface Frame {
  readonly frameId: string
  readonly stateRevision: number
  readonly width: number
  readonly height: number
  readonly stride: number
  readonly cells: readonly TerminalCell[]
  readonly cursor: { readonly x: number; readonly y: number; readonly visible: boolean }
  readonly modes: TerminalModeSnapshot
  readonly resources: FrameResources
  readonly images: readonly FrameImagePlacement[]
  readonly layers: readonly FrameLayer[]
  readonly generation: number
  readonly fullRedraw: boolean
  readonly metadata: FrameMetadata
}

export interface FrameMetadata {
  readonly changedRows: number
  readonly renderMs: number
  readonly diffMs: number
  readonly terminalProfileId: string
  readonly fullRedrawReason?: 'initial' | 'resize' | 'resume' | 'damage' | 'unknown-mode' | 'cleanup'
  /**
   * WP-07 inline live-region hint (frame = screen invariant): rows
   * [0..liveStart) are settled transcript lines (append-only candidates —
   * they may leave the screen only INTO scrollback, never mutate in place);
   * rows [liveStart..height) are the mutable live region (dock + streaming
   * rows + unseen indicator) that backends repaint in place. Producers:
   * app/inline-live-region.ts via buildFrame's `inlineHint`; the compositor
   * passes it through. Absent on fullscreen frames; inline backends treat a
   * missing/out-of-range hint as "everything is live" (repaint fallback).
   */
  readonly inline?: InlineFrameHint
}

/**
 * WP-07 inline frame hint (see FrameMetadata.inline). `followEnd` is true
 * only when the transcript window is pinned to the content end in this frame
 * and the previous one — the backend may scroll settled lines into scrollback
 * only then (append-only growth); internal scrolling frames repaint in place
 * and feed nothing (no scrollback duplicates).
 */
export interface InlineFrameHint {
  readonly liveStart: number
  readonly followEnd: boolean
}

export interface ScreenBackendCapabilities {
  supportsViewportLayout: boolean
  supportsNestedOverlay: boolean
  supportsScrollRegion: boolean
  supportsInlineLiveRegion: boolean
}
export interface ScreenBackend {
  mode: 'fullscreen' | 'inline'
  capabilities: ScreenBackendCapabilities
  start(generation: number): Promise<void>
  plan(previous: Frame | null, next: Frame): TerminalPatch
  stop(generation: number): Promise<void>
}

export interface FrameImagePlacement {
  readonly imageId: string
  readonly protocol: 'kitty' | 'iterm2'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly payloadHash: string
  readonly storeKey: string
}

export interface ImageStore {
  put(payloadHash: string, bytes: Uint8Array, protocol: 'kitty' | 'iterm2'): Promise<{ storeKey: string; bytes: number }>
  get(storeKey: string): Promise<Uint8Array | null>
  release(storeKey: string): void
  clearGeneration(generation: number): void
  stats(): { entries: number; bytes: number; maxBytes: number }
}

export type PatchOperation =
  | { kind: 'write-cells'; x: number; y: number; cells: readonly TerminalCell[] }
  | { kind: 'erase'; x: number; y: number; width: number; height: number }
  | { kind: 'scroll'; top: number; bottom: number; delta: number }
  | { kind: 'cursor'; x: number; y: number; visible: boolean }
  | { kind: 'mode'; name: keyof TerminalModeSnapshot; value: null | boolean | number | string | TerminalModeSnapshot['scrollRegion'] | TerminalModeSnapshot['progress'] }
  | { kind: 'resources'; resources: FrameResources }
  /**
   * WP-07 inline initial paint: write one full row at the CURRENT cursor
   * position (no CUP — the session's starting row is wherever the shell left
   * the cursor). Encoded as CR + cell payload + (feed ? LF : nothing). A feed
   * at the bottom row of a full-height main-screen scroll region pushes the
   * top line into scrollback (the only scrollback-producing primitive inline
   * mode uses). Requires a preceding resources op; cells[0] must not be a
   * width-0 continuation. Only the inline backend emits this, and only on
   * the initial paint recipe.
   */
  | { kind: 'append'; cells: readonly TerminalCell[]; feed: boolean }
  /**
   * WP-07 inline scroll primitive: CUP to (y+1, 1) then `count` line feeds.
   * With y === height-1 on a full-height main-screen region each feed pushes
   * the current top screen line into scrollback and opens a blank bottom row
   * (append-only transcript scroll). Never emitted by the fullscreen backend;
   * never touches ED 3 or DECSTBM.
   */
  | { kind: 'line-feed'; y: number; count: number }
  | { kind: 'image-upload'; storeKey: string; protocol: 'kitty' | 'iterm2'; payloadHash: string }
  | { kind: 'image-place'; placement: FrameImagePlacement }
  | { kind: 'image-delete'; storeKey: string }
  | { kind: 'image-clear' }
export interface TerminalPatch {
  readonly frameId: string
  readonly stateRevision: number
  readonly patchSeq: number
  readonly generation: number
  readonly operations: readonly PatchOperation[]
  readonly bytes: number
  readonly fullRedraw: boolean
}
