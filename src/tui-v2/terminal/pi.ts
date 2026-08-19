/**
 * tui-v2 pi facade (WP-03a, plan §4.2/§4.3/WP-03).
 *
 * This file is the ONLY re-export port of the vendored fork
 * (`../vendor/pi-tui/`). Business code must import pi primitives from here,
 * never from `src/tui-v2/vendor/pi-tui/**` directly; the boundary is enforced
 * by `pnpm verify:tui-v2 -- --check fork` (import guard).
 *
 * The vendored tree is currently pristine + the mechanical `.ts`→`.js`
 * specifier rewrite (see vendor/pi-tui/PATCH-LEDGER.md). Fork patches
 * (PatchSink call-site rewiring, profile integration, …) start in WP-03b and
 * each one gets a ledger row; the facade surface then narrows to what the v2
 * kernel actually consumes.
 *
 * The export list below is curated and grouped by vendored module; extend it
 * deliberately, never with `export *`.
 */

// --- tui core (tui.ts) -----------------------------------------------------
export type {
  Component,
  Focusable,
  TuiInputListener,
  TuiInputListenerResult,
  OverlayAnchor,
  OverlayMargin,
  OverlayOptions,
  OverlayUnfocusOptions,
  OverlayHandle,
  SizeValue,
  TuiMode,
  TuiStopOptions,
  TUI,
  ViewportTUI,
} from '../vendor/pi-tui/src/tui.js'
export {
  isFocusable,
  isViewportTUI,
  Container,
  TuiBase,
  CURSOR_MARKER,
  VIEWPORT_TUI,
  compositeTuiLine,
} from '../vendor/pi-tui/src/tui.js'

// --- terminal process backend (terminal.ts) --------------------------------
export type { Terminal, KeyboardProtocolNegotiationSequence } from '../vendor/pi-tui/src/terminal.js'
export {
  ProcessTerminal,
  parseKeyboardProtocolNegotiationSequence,
  isAppleTerminalSession,
  normalizeNativeShiftEnterInput,
  normalizeAppleTerminalInput,
  resolveEscapeTimeoutMs,
} from '../vendor/pi-tui/src/terminal.js'

// --- main/alt screen backends ----------------------------------------------
export type { TuiMainScreenRenderState } from '../vendor/pi-tui/src/tui-main-screen.js'
export { TuiMainScreen } from '../vendor/pi-tui/src/tui-main-screen.js'
export type { TuiAltScreenOptions } from '../vendor/pi-tui/src/tui-alt-screen.js'
export { TuiAltScreen } from '../vendor/pi-tui/src/tui-alt-screen.js'

// --- layout (layout.ts / layout-node.ts) ------------------------------------
export type { LayoutRect, LayoutBox, LayoutFrame, ScrollbarGeometry } from '../vendor/pi-tui/src/layout.js'
export {
  getScrollbarGeometry,
  renderLayoutFrame,
  getScrollViewBox,
  getScrollViewsAt,
} from '../vendor/pi-tui/src/layout.js'
export type {
  LayoutViewport,
  StackLayoutEntry,
  StackLayoutNode,
  ScrollLayoutState,
  ScrollLayoutNode,
  LayoutNode,
  LayoutComponent,
} from '../vendor/pi-tui/src/layout-node.js'
export { LAYOUT_NODE, getLayoutNode } from '../vendor/pi-tui/src/layout-node.js'

// --- input (keys.ts / stdin-buffer.ts) --------------------------------------
export type { KeyId, KeyEventType } from '../vendor/pi-tui/src/keys.js'
export {
  Key,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  parseKey,
  decodeKittyPrintable,
  decodePrintableKey,
  setKittyProtocolActive,
  isKittyProtocolActive,
} from '../vendor/pi-tui/src/keys.js'
export type { StdinBufferOptions, StdinBufferEventMap } from '../vendor/pi-tui/src/stdin-buffer.js'
export { StdinBuffer } from '../vendor/pi-tui/src/stdin-buffer.js'

// --- keybindings / editor component contract --------------------------------
export type {
  Keybindings,
  Keybinding,
  KeybindingDefinition,
  KeybindingDefinitions,
  KeybindingsConfig,
  KeybindingConflict,
} from '../vendor/pi-tui/src/keybindings.js'
export { TUI_KEYBINDINGS, KeybindingsManager, setKeybindings, getKeybindings } from '../vendor/pi-tui/src/keybindings.js'
export type { EditorComponent } from '../vendor/pi-tui/src/editor-component.js'

// --- autocomplete -------------------------------------------------------------
export type {
  AutocompleteItem,
  SlashCommand,
  AutocompleteSuggestions,
  AutocompleteProvider,
} from '../vendor/pi-tui/src/autocomplete.js'
export { CombinedAutocompleteProvider } from '../vendor/pi-tui/src/autocomplete.js'

// --- width / ansi line utils (utils.ts) --------------------------------------
export {
  getGraphemeSegmenter,
  getWordSegmenter,
  visibleWidth,
  stripTerminalSequences,
  getGraphemeCellRange,
  getOsc8LinkAtColumn,
  normalizeTerminalOutput,
  extractAnsiCode,
  wrapTextWithAnsi,
  applyBackgroundToLine,
  truncateToWidth,
  sliceByColumn,
  sliceWithWidth,
  extractSegments,
} from '../vendor/pi-tui/src/utils.js'

// --- terminal colors (OSC 10/11 probing parsers) ------------------------------
export type { RgbColor, TerminalColorScheme } from '../vendor/pi-tui/src/terminal-colors.js'
export {
  isOsc11BackgroundColorResponse,
  parseOsc11BackgroundColor,
  parseTerminalColorSchemeReport,
} from '../vendor/pi-tui/src/terminal-colors.js'

// --- image line primitives (terminal-image.ts) --------------------------------
// Only the line-level predicates the screen backends rely on are exposed here;
// capability probing is replaced by terminal/profile.ts in WP-03b.
export { isImageLine, setCellDimensions } from '../vendor/pi-tui/src/terminal-image.js'

// --- line components -----------------------------------------------------------
export type { StackEntryOptions, StackEntry, StackChild, StackOptions } from '../vendor/pi-tui/src/components/stack.js'
export { Stack, visibleStackEntries, allocateStackSizes } from '../vendor/pi-tui/src/components/stack.js'
export { VStack } from '../vendor/pi-tui/src/components/v-stack.js'
export { HStack } from '../vendor/pi-tui/src/components/h-stack.js'
export { Text } from '../vendor/pi-tui/src/components/text.js'
export { TruncatedText } from '../vendor/pi-tui/src/components/truncated-text.js'
export type { EditorTheme, EditorOptions } from '../vendor/pi-tui/src/components/editor.js'
export { Editor } from '../vendor/pi-tui/src/components/editor.js'
export type {
  ScrollViewScrollbar,
  ScrollViewOptions,
  ScrollViewScrollToOptions,
} from '../vendor/pi-tui/src/components/scroll-view.js'
export { ScrollView } from '../vendor/pi-tui/src/components/scroll-view.js'
export { Spacer } from '../vendor/pi-tui/src/components/spacer.js'
export { Box } from '../vendor/pi-tui/src/components/box.js'
