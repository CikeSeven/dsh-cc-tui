/**
 * DSH fork-added module (no upstream counterpart; VENDOR-MANIFEST
 * upstreamSha256: null, see PATCH-LEDGER.md).
 *
 * PiOutputEncoder — typed builders for every control-plane sequence the
 * forked Tui/TuiMainScreen/TuiAltScreen write to the terminal. Each builder
 * emits the EXACT byte string the upstream call site used (upstream behavior
 * is unchanged; only the construction site is typed), so the vendored
 * upstream tests keep passing byte-for-byte.
 *
 * Why this exists: on the dsh runtime, `Terminal.write(string)` is the
 * PiTerminalAdapter compat boundary. The adapter strictly parses everything
 * with `parsePiTerminalString` (./pi-string-parser.js); only sequences
 * produced by these builders (plus declared image markers from
 * terminal-image.ts and data-plane line content) are in the parser
 * allowlist. Call sites must never hand-concatenate CSI/OSC literals.
 *
 * This module is deliberately self-contained (no imports) so the vendored
 * tree never references `src/tui-v2/terminal/` (import-guard rule).
 */

function requireCount(name: string, value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > 9999) {
		throw new RangeError(`${name} must be an integer in [1, 9999], got ${value}`);
	}
	return value;
}

const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_OSC52_PAYLOAD_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// synchronized output / screen / modes
// ---------------------------------------------------------------------------

/** Begin synchronized output (DECSET 2026). */
export function syncOutputBegin(): string {
	return "\x1b[?2026h";
}

/** End synchronized output (DECRST 2026). */
export function syncOutputEnd(): string {
	return "\x1b[?2026l";
}

export function enterAltScreen(): string {
	return "\x1b[?1049h";
}

export function exitAltScreen(): string {
	return "\x1b[?1049l";
}

export function setAutowrap(enabled: boolean): string {
	return enabled ? "\x1b[?7h" : "\x1b[?7l";
}

/** Button-motion tracking + focus reporting + SGR encoding (multiplexer-safe). */
export function enableButtonMotionMouse(): string {
	return "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
}

/** Any-motion tracking + focus reporting + SGR encoding. */
export function enableAllMotionMouse(): string {
	return "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
}

export function disableMouse(): string {
	return "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
}

export function setCursorVisible(visible: boolean): string {
	return visible ? "\x1b[?25h" : "\x1b[?25l";
}

/** Color-scheme change notifications (DECSET/DECRST 2031). */
export function setColorSchemeNotifications(enabled: boolean): string {
	return enabled ? "\x1b[?2031h" : "\x1b[?2031l";
}

// ---------------------------------------------------------------------------
// erase / cursor
// ---------------------------------------------------------------------------

/** ED 2 — erase the visible display. */
export function eraseDisplay(): string {
	return "\x1b[2J";
}

/** ED 3 — clear the scrollback buffer. */
export function eraseScrollback(): string {
	return "\x1b[3J";
}

/** Composite: ED 2 + CUP home + ED 3 (main-screen full-clear form). */
export function clearScreenHomeScrollback(): string {
	return "\x1b[2J\x1b[H\x1b[3J";
}

/** EL 2 — erase the current line. */
export function eraseLine(): string {
	return "\x1b[2K";
}

/** CUP home (row 1, column 1). */
export function cursorHome(): string {
	return "\x1b[H";
}

export function cursorUp(lines: number): string {
	return `\x1b[${requireCount("cursorUp", lines)}A`;
}

export function cursorDown(lines: number): string {
	return `\x1b[${requireCount("cursorDown", lines)}B`;
}

/** CHA — absolute column, 1-based. */
export function cursorColumn(column: number): string {
	return `\x1b[${requireCount("cursorColumn", column)}G`;
}

/** CUP — absolute position, 1-based row/column. */
export function cursorTo(row: number, column: number): string {
	return `\x1b[${requireCount("cursorTo row", row)};${requireCount("cursorTo column", column)}H`;
}

export function carriageReturn(): string {
	return "\r";
}

/** Controlled newline (CRLF) — the only line advance the fork emits. */
export function newline(): string {
	return "\r\n";
}

// ---------------------------------------------------------------------------
// data-plane helpers embedded in composed buffers
// ---------------------------------------------------------------------------

/** SGR reset (used between composed spans and at stop). */
export function sgrReset(): string {
	return "\x1b[0m";
}

/** Line-content boundary reset: SGR reset + OSC 8 hyperlink close. */
export function segmentReset(): string {
	return "\x1b[0m\x1b]8;;\x07";
}

// ---------------------------------------------------------------------------
// queries (registered with the adapter parser) + clipboard
// ---------------------------------------------------------------------------

/** CSI 16 t — cell geometry in pixels (response: CSI 6 ; height ; width t). */
export function queryCellSize(): string {
	return "\x1b[16t";
}

/** OSC 11 ; ? — default background color query. */
export function queryBackgroundColor(): string {
	return "\x1b]11;?\x07";
}

/** DSR 996 — color-scheme preference query (response: CSI ? 997 ; 1|2 n). */
export function queryColorScheme(): string {
	return "\x1b[?996n";
}

/** OSC 52 clipboard write; payload must already be base64. */
export function osc52Clipboard(payloadBase64: string): string {
	if (typeof payloadBase64 !== "string" || payloadBase64.length === 0 || !BASE64_CHARS.test(payloadBase64)) {
		throw new TypeError("osc52Clipboard payload must be a non-empty base64 string");
	}
	// UTF-16 length is a lower bound for the byte length; exact check below.
	if (payloadBase64.length > MAX_OSC52_PAYLOAD_BYTES) {
		throw new RangeError(`osc52Clipboard payload exceeds ${MAX_OSC52_PAYLOAD_BYTES} chars`);
	}
	return `\x1b]52;c;${payloadBase64}\x07`;
}
