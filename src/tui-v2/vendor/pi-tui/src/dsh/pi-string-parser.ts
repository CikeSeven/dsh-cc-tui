/**
 * DSH fork-added module (no upstream counterpart; VENDOR-MANIFEST
 * upstreamSha256: null, see PATCH-LEDGER.md).
 *
 * parsePiTerminalString — the STRICT parser behind the dsh
 * PiTerminalAdapter compat boundary (`Terminal.write(string)`). It accepts
 * exactly the sequences the fork can produce:
 *
 *   - printable text (code point ≥ U+0020, excluding U+007F–U+009F)
 *   - controlled newlines: CRLF / CR / LF
 *   - SGR (CSI [0-9;:]* m)                              — data plane
 *   - OSC 8 hyperlinks, BEL or ST terminated            — data plane
 *   - relative cursor moves (CSI n A/B/C/D), CHA (CSI n G), CUP (CSI r;c H)
 *   - erases: EL 0–2 (CSI n K), ED 0–3 (CSI n J)
 *   - DEC modes from the pinned allowlist (CSI ? mode h/l): 7, 25, 47,
 *     1000, 1002, 1003, 1004, 1006, 1015, 1047, 1049, 2004, 2026, 2031
 *   - registered queries: CSI 16 t (cell size), OSC 11 ; ? (background
 *     color), CSI ? 996 n (color scheme)
 *   - OSC 0/2 window title, OSC 9 ; 4 progress, OSC 52 clipboard
 *   - declared image markers: kitty APC (ESC _ G … ST) and iTerm2
 *     OSC 1337 ; File=… : payload BEL — the terminal-image.ts forms
 *
 * Everything else — unknown CSI/DEC/OSC, unregistered APC (e.g. the pi
 * CURSOR_MARKER `_pi:c`, which components must strip before render),
 * malformed/unterminated-then-resumed sequences, C0/C1/DEL junk, payloads
 * over 8 MiB — is rejected with code `unsupported-pi-sequence`. NOTHING is
 * passed through unparsed.
 *
 * The parser is a pure function. A trailing PARTIAL sequence (a write chunk
 * boundary split one) is reported as `remainder`; the adapter buffers it and
 * prepends it to the next write before parsing again.
 */

export type PiParsedOperation =
	| { kind: "text"; text: string }
	| { kind: "newline" } // CRLF — the fork's only line advance
	| { kind: "carriage-return" } // lone CR
	| { kind: "line-feed" } // lone LF
	| { kind: "sgr"; raw: string; params: string }
	| { kind: "hyperlink"; raw: string; params: string; uri: string } // uri "" closes
	| { kind: "cursor-up"; count: number }
	| { kind: "cursor-down"; count: number }
	| { kind: "cursor-forward"; count: number }
	| { kind: "cursor-back"; count: number }
	| { kind: "cursor-column"; column: number } // CHA, 1-based
	| { kind: "cursor-to"; row: number; column: number } // CUP, 1-based
	| { kind: "erase-line"; mode: 0 | 1 | 2 }
	| { kind: "erase-display"; mode: 0 | 1 | 2 | 3 }
	| { kind: "mode"; mode: number; enabled: boolean }
	| { kind: "query"; query: "cell-size" | "background-color" | "color-scheme" }
	| { kind: "title"; value: string }
	| { kind: "progress"; state: 0 | 1 | 2 | 3 | 4; value?: number }
	| { kind: "clipboard"; payloadBase64: string }
	| { kind: "image"; protocol: "kitty"; keys: [string, string][]; payloadBase64: string }
	| { kind: "image"; protocol: "iterm2"; params: [string, string][]; payloadBase64: string };

export interface PiParseError {
	readonly code: "unsupported-pi-sequence";
	readonly message: string;
	/** Offset in the parsed input where the offending sequence starts. */
	readonly offset: number;
}

export type PiParseResult =
	| { ok: true; operations: PiParsedOperation[]; remainder: string }
	| { ok: false; error: PiParseError };

/** Hard cap for one write payload and for any single OSC/APC body (§5.6). */
export const PI_STRING_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const MAX_CURSOR_PARAM = 9999;
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

/** DEC private modes the fork may set/reset through the compat boundary. */
const PI_DEC_MODE_ALLOWLIST: ReadonlySet<number> = new Set([
	7, 25, 47, 1000, 1002, 1003, 1004, 1006, 1015, 1047, 1049, 2004, 2026, 2031,
]);

export function parsePiTerminalString(input: string): PiParseResult {
	if (typeof input !== "string") {
		throw new TypeError("parsePiTerminalString input must be a string");
	}
	if (Buffer.byteLength(input, "utf8") > PI_STRING_MAX_PAYLOAD_BYTES) {
		return fail(0, `write payload exceeds ${PI_STRING_MAX_PAYLOAD_BYTES} bytes`);
	}

	const operations: PiParsedOperation[] = [];
	let textStart = -1;
	let i = 0;

	const flushText = (end: number): void => {
		if (textStart !== -1 && end > textStart) {
			operations.push({ kind: "text", text: input.slice(textStart, end) });
		}
		textStart = -1;
	};

	while (i < input.length) {
		const cp = input.codePointAt(i) as number;

		if (cp >= 0x20 && !(cp >= 0x7f && cp <= 0x9f)) {
			if (textStart === -1) textStart = i;
			i += cp > 0xffff ? 2 : 1;
			continue;
		}

		if (cp === 0x0d) {
			flushText(i);
			if (input.charCodeAt(i + 1) === 0x0a) {
				operations.push({ kind: "newline" });
				i += 2;
			} else {
				operations.push({ kind: "carriage-return" });
				i += 1;
			}
			continue;
		}
		if (cp === 0x0a) {
			flushText(i);
			operations.push({ kind: "line-feed" });
			i += 1;
			continue;
		}

		if (cp !== 0x1b) {
			// BEL (outside OSC), other C0, DEL, C1: never safe.
			return fail(i, `control character U+${cp.toString(16)} is not allowed in pi output`);
		}

		flushText(i);
		const next = input.charCodeAt(i + 1);
		if (Number.isNaN(next)) {
			// Lone trailing ESC: incomplete sequence.
			return { ok: true, operations, remainder: input.slice(i) };
		}
		if (next === 0x5b) {
			const parsed = parseCsi(input, i);
			if ("remainder" in parsed) return { ok: true, operations, remainder: parsed.remainder };
			if ("error" in parsed) return parsed.error;
			operations.push(parsed.operation);
			i = parsed.end;
			continue;
		}
		if (next === 0x5d) {
			const parsed = parseOsc(input, i);
			if ("remainder" in parsed) return { ok: true, operations, remainder: parsed.remainder };
			if ("error" in parsed) return parsed.error;
			operations.push(parsed.operation);
			i = parsed.end;
			continue;
		}
		if (next === 0x5f) {
			const parsed = parseApc(input, i);
			if ("remainder" in parsed) return { ok: true, operations, remainder: parsed.remainder };
			if ("error" in parsed) return parsed.error;
			operations.push(parsed.operation);
			i = parsed.end;
			continue;
		}
		return fail(i, `unknown escape sequence introducer 0x${next.toString(16)} (only CSI/OSC/declared APC)`);
	}

	flushText(input.length);
	return { ok: true, operations, remainder: "" };
}

// ---------------------------------------------------------------------------
// CSI
// ---------------------------------------------------------------------------

type SequenceParse =
	| { operation: PiParsedOperation; end: number }
	| { remainder: string }
	| { error: { ok: false; error: PiParseError } };

function parseCsi(input: string, start: number): SequenceParse {
	// params: 0x30–0x3F, intermediates: 0x20–0x2F, final: 0x40–0x7E
	let i = start + 2;
	const paramsStart = i;
	while (i < input.length) {
		const c = input.charCodeAt(i);
		if (c >= 0x30 && c <= 0x3f) i += 1;
		else break;
	}
	const paramsEnd = i;
	while (i < input.length) {
		const c = input.charCodeAt(i);
		if (c >= 0x20 && c <= 0x2f) i += 1;
		else break;
	}
	if (i >= input.length) return { remainder: input.slice(start) };
	const finalCode = input.charCodeAt(i);
	if (finalCode < 0x40 || finalCode > 0x7e) {
		return { error: fail(start, `malformed CSI (bad final byte 0x${finalCode.toString(16)})`) };
	}
	const params = input.slice(paramsStart, paramsEnd);
	const intermediates = input.slice(paramsEnd, i);
	const end = i + 1;

	if (intermediates !== "") {
		return { error: fail(start, `CSI with intermediates '${intermediates}' is not in the pi allowlist`) };
	}
	const final = String.fromCharCode(finalCode);

	switch (final) {
		case "m": {
			if (!/^[0-9;:]*$/.test(params)) return { error: fail(start, `SGR with non-standard params '${params}'`) };
			return { operation: { kind: "sgr", raw: input.slice(start, end), params }, end };
		}
		case "A":
		case "B":
		case "C":
		case "D": {
			const count = parseCount(params);
			if (count === null) return { error: fail(start, `cursor move with bad count '${params}'`) };
			const kind =
				final === "A" ? "cursor-up" : final === "B" ? "cursor-down" : final === "C" ? "cursor-forward" : "cursor-back";
			return { operation: { kind, count }, end };
		}
		case "G": {
			const column = parseCount(params);
			if (column === null) return { error: fail(start, `CHA with bad column '${params}'`) };
			return { operation: { kind: "cursor-column", column }, end };
		}
		case "H": {
			const match = /^(\d*)(?:;(\d*))?$/.exec(params);
			if (match === null) return { error: fail(start, `CUP with bad params '${params}'`) };
			const row = clampParam(match[1] === "" || match[1] === undefined ? 1 : Number.parseInt(match[1], 10));
			const column = clampParam(match[2] === "" || match[2] === undefined ? 1 : Number.parseInt(match[2], 10));
			if (row === null || column === null) return { error: fail(start, `CUP param out of range '${params}'`) };
			return { operation: { kind: "cursor-to", row, column }, end };
		}
		case "J": {
			const mode = params === "" ? 0 : Number.parseInt(params, 10);
			if (!/^\d*$/.test(params) || mode < 0 || mode > 3) {
				return { error: fail(start, `ED mode '${params}' outside 0–3`) };
			}
			return { operation: { kind: "erase-display", mode: mode as 0 | 1 | 2 | 3 }, end };
		}
		case "K": {
			const mode = params === "" ? 0 : Number.parseInt(params, 10);
			if (!/^\d*$/.test(params) || mode < 0 || mode > 2) {
				return { error: fail(start, `EL mode '${params}' outside 0–2`) };
			}
			return { operation: { kind: "erase-line", mode: mode as 0 | 1 | 2 }, end };
		}
		case "h":
		case "l": {
			const match = /^\?(\d+)$/.exec(params);
			if (match === null) return { error: fail(start, `mode set/reset with bad params '${params}'`) };
			const mode = Number.parseInt(match[1] as string, 10);
			if (!PI_DEC_MODE_ALLOWLIST.has(mode)) {
				return { error: fail(start, `DEC mode ${mode} is not in the pi allowlist`) };
			}
			return { operation: { kind: "mode", mode, enabled: final === "h" }, end };
		}
		case "n": {
			if (params === "?996") return { operation: { kind: "query", query: "color-scheme" }, end };
			return { error: fail(start, `DSR '${params}n' is not a registered pi query`) };
		}
		case "t": {
			if (params === "16") return { operation: { kind: "query", query: "cell-size" }, end };
			return { error: fail(start, `window-op '${params}t' is not a registered pi query`) };
		}
		default:
			return { error: fail(start, `CSI ${params} ${final} is not in the pi allowlist`) };
	}
}

/** Cursor counts: omitted or 0 both mean 1 (terminal-default clamp). */
function parseCount(params: string): number | null {
	if (!/^\d*$/.test(params)) return null;
	const value = params === "" ? 1 : Number.parseInt(params, 10);
	return clampParam(value === 0 ? 1 : value);
}

function clampParam(value: number): number | null {
	if (!Number.isInteger(value) || value < 1 || value > MAX_CURSOR_PARAM) return null;
	return value;
}

// ---------------------------------------------------------------------------
// OSC (BEL or ST terminated)
// ---------------------------------------------------------------------------

function parseOsc(input: string, start: number): SequenceParse {
	let i = start + 2;
	let terminatedBy = "";
	for (;;) {
		if (i >= input.length) return { remainder: input.slice(start) };
		const c = input.charCodeAt(i);
		if (c === 0x07) {
			terminatedBy = "\x07";
			break;
		}
		if (c === 0x1b) {
			if (input.charCodeAt(i + 1) === 0x5c) {
				terminatedBy = "\x1b\\";
				break;
			}
			return { error: fail(start, "OSC body contains a stray ESC (unclosed sequence)") };
		}
		if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
			return { error: fail(start, `control character in OSC body at offset ${i}`) };
		}
		i += 1;
	}
	const body = input.slice(start + 2, i);
	const end = i + terminatedBy.length;
	if (Buffer.byteLength(body, "utf8") > PI_STRING_MAX_PAYLOAD_BYTES) {
		return { error: fail(start, `OSC payload exceeds ${PI_STRING_MAX_PAYLOAD_BYTES} bytes`) };
	}
	const raw = input.slice(start, end);

	if (body.startsWith("8;")) {
		const rest = body.slice(2);
		const separator = rest.indexOf(";");
		if (separator === -1) return { error: fail(start, "OSC 8 without params/uri separator") };
		return {
			operation: {
				kind: "hyperlink",
				raw,
				params: rest.slice(0, separator),
				uri: rest.slice(separator + 1),
			},
			end,
		};
	}
	if (body.startsWith("0;") || body.startsWith("2;")) {
		return { operation: { kind: "title", value: body.slice(2) }, end };
	}
	if (body.startsWith("9;4;")) {
		const rest = body.slice(4);
		const match = /^([0-4])(?:;(\d+))?$/.exec(rest);
		if (match === null) return { error: fail(start, `OSC 9;4 with bad state '${rest}'`) };
		const state = Number.parseInt(match[1] as string, 10) as 0 | 1 | 2 | 3 | 4;
		const value = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
		if (value !== undefined && (value < 0 || value > 100)) {
			return { error: fail(start, `OSC 9;4 progress value ${value} outside 0–100`) };
		}
		return { operation: value === undefined ? { kind: "progress", state } : { kind: "progress", state, value }, end };
	}
	if (body.startsWith("52;c;")) {
		const payload = body.slice(5);
		if (!BASE64_CHARS.test(payload) || payload.length === 0) {
			return { error: fail(start, "OSC 52 payload must be non-empty base64") };
		}
		return { operation: { kind: "clipboard", payloadBase64: payload }, end };
	}
	if (body === "11;?") {
		return { operation: { kind: "query", query: "background-color" }, end };
	}
	if (body.startsWith("1337;File=")) {
		const rest = body.slice("1337;File=".length);
		const colon = rest.indexOf(":");
		if (colon === -1) return { error: fail(start, "iTerm2 image without params/payload separator") };
		const params = parseKeyValueList(rest.slice(0, colon), ";");
		if (params === null) return { error: fail(start, "iTerm2 image with malformed params") };
		const payload = rest.slice(colon + 1);
		if (!BASE64_CHARS.test(payload) || payload.length === 0) {
			return { error: fail(start, "iTerm2 image payload must be non-empty base64") };
		}
		return { operation: { kind: "image", protocol: "iterm2", params, payloadBase64: payload }, end };
	}
	return { error: fail(start, `OSC '${body.slice(0, 32)}…' is not in the pi allowlist`) };
}

// ---------------------------------------------------------------------------
// APC — only the declared kitty graphics marker (ESC _ G … ST)
// ---------------------------------------------------------------------------

function parseApc(input: string, start: number): SequenceParse {
	if (input.charCodeAt(start + 2) !== 0x47) {
		// ESC _ <not G>: unregistered APC (includes the pi CURSOR_MARKER _pi:c).
		return { error: fail(start, "unregistered APC (only the kitty graphics marker is declared)") };
	}
	let i = start + 3;
	for (;;) {
		if (i >= input.length) return { remainder: input.slice(start) };
		const c = input.charCodeAt(i);
		if (c === 0x1b) {
			if (input.charCodeAt(i + 1) === 0x5c) break;
			return { error: fail(start, "APC body contains a stray ESC (unclosed sequence)") };
		}
		if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
			return { error: fail(start, `control character in APC body at offset ${i}`) };
		}
		i += 1;
	}
	const body = input.slice(start + 3, i);
	const end = i + 2;
	if (Buffer.byteLength(body, "utf8") > PI_STRING_MAX_PAYLOAD_BYTES) {
		return { error: fail(start, `APC payload exceeds ${PI_STRING_MAX_PAYLOAD_BYTES} bytes`) };
	}

	const separator = body.indexOf(";");
	const keysText = separator === -1 ? body : body.slice(0, separator);
	const payload = separator === -1 ? "" : body.slice(separator + 1);
	const keys = parseKeyValueList(keysText, ",");
	if (keys === null || keys.length === 0) {
		return { error: fail(start, "kitty marker with malformed key list") };
	}
	if (payload === "") {
		const action = keys.find(([key]) => key === "a")?.[1];
		if (action !== "d" && action !== "p") {
			return { error: fail(start, "kitty marker without payload is only declared for a=d / a=p") };
		}
	} else if (!BASE64_CHARS.test(payload)) {
		return { error: fail(start, "kitty payload must be base64") };
	}
	return { operation: { kind: "image", protocol: "kitty", keys, payloadBase64: payload }, end };
}

/** Parse `k=v` pairs joined by `separator`, preserving order. */
function parseKeyValueList(text: string, separator: string): [string, string][] | null {
	if (text === "") return null;
	const out: [string, string][] = [];
	for (const pair of text.split(separator)) {
		const match = /^([A-Za-z][A-Za-z0-9]*)=([A-Za-z0-9_+.:/%-]*)$/.exec(pair);
		if (match === null) return null;
		out.push([match[1] as string, match[2] as string]);
	}
	return out;
}

function fail(offset: number, message: string): { ok: false; error: PiParseError } {
	return { ok: false, error: { code: "unsupported-pi-sequence", message, offset } };
}
