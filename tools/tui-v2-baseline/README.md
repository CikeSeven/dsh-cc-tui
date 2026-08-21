# Offline tui-v2 baseline tool

`tools/tui-v2-baseline/` is a dev-only, offline boundary for WP-09a. It is not
part of `src/`, the production bootstrap, package exports, or the runtime
archive. Production code must never import this directory.

The committed `artifacts/v1-capture@v1.json` is a deliberately frozen capture
record. Its provenance is locked in `manifest.json`:

- source commit: `5422c8d84f36f01907df5e2fcad2e0b8b6d7a2be`
- source tree/file hashes: see `manifest.json`
- license: repository `LICENSE`, SPDX `MIT`, hash pinned in both manifest and artifact
- capture backend: `frozen-artifact`
- redaction version: `1`

`capture.ts` replays bytes from the artifact into an injected
`FakeTerminalWriter` and `VirtualTerminal`. It does not create an Ink/React
root, subscribe to a live Channel, execute commands, write a session, access
real stdout/stderr, or start a timer. `side-effect-spy.ts` records those
categories and the capture contract permits only fake-writer activity. Every
scope restores patched functions in `finally`.

Reports are hash- and coordinate-based. Raw ANSI, OSC data, prompts, tool
arguments, credentials, and real stream payloads must not be emitted. Compare
uses the repository's `compareGrid` entry point for canonical grid assertions;
cursor, modes, width, bytes, frame counts, and bounded memory fields remain
separate report projections.

The artifact is an offline migration reference, not a production fallback.
WP-09b may delete the old runtime source without invalidating this artifact;
WP-09c owns release tarball/launcher rollback verification.
