/**
 * WP-04 walking-skeleton child process.
 *
 * Runs the full v2 chain (fake Channel → adapter → streaming → reducer →
 * selectors → base-renderer → linesToFrame → backend.plan → writer → VT)
 * against a real-process signal host, then writes a JSON report:
 *
 *   skeleton-child.ts <scenario> <reportPath> [profileId]
 *
 * Scenarios:
 *   normal  — full conversation script, clean stop('user-exit'), exit 0
 *   sigterm — print READY, wait for SIGTERM (lifecycle → stop('sigterm')), exit 0
 *   error   — injected uncaughtException → stop('error'), report, exit 3
 *
 * Spawned as: process.execPath --import tsx/esm <this file> ...
 */

const [scenario, reportPath, profileId = 'kitty-sync'] = process.argv.slice(2);
if (!scenario || !reportPath) {
  console.error('skeleton-child: usage: <scenario> <reportPath> [profileId]');
  process.exit(2);
}

const [
  { mkdir, writeFile },
  path,
  { PassThrough, Writable },
  { createFakeChannel },
  { createTuiV2Coordinator },
  { getProfile },
  { unknownConservativeDefaults },
  { VirtualTerminal },
] = await Promise.all([
  import('node:fs/promises'),
  import('node:path'),
  import('node:stream'),
  import('./fake-channel.js'),
  import('../../../src/tui-v2/app/coordinator.js'),
  import('../../../src/tui-v2/testkit/terminal-profiles.js'),
  import('../../../src/tui-v2/terminal/profile.js'),
  import('../../../src/tui-v2/testkit/virtual-terminal.js'),
]);

type VT = InstanceType<typeof VirtualTerminal>;

class FakeStdin extends PassThrough {
  readonly isTTY = true;
  readonly rawModes: boolean[] = [];
  override setRawMode(raw: boolean): void {
    this.rawModes.push(raw);
  }
}

class VtStream extends Writable {
  constructor(private readonly vt: VT) {
    super();
  }
  override _write(chunk: unknown, _enc: string, cb: (error?: Error | null) => void): void {
    this.vt.write(String(chunk));
    cb();
  }
}

const realClock = {
  now: () => Date.now(),
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (condition()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(10);
  }
}

function screenText(vt: VT): string {
  const snapshot = vt.snapshot();
  const lines: string[] = [];
  for (let y = 0; y < snapshot.height; y++) {
    lines.push(
      snapshot.cells
        .slice(y * snapshot.width, (y + 1) * snapshot.width)
        .map((cell) => cell.grapheme)
        .join(''),
    );
  }
  return lines.join('\n');
}

function defaultModes(vt: VT): Record<string, unknown> {
  const modes = vt.snapshot().modes;
  return {
    alternateScreen: modes.alternateScreen,
    rawInput: modes.rawInput,
    bracketedPaste: modes.bracketedPaste,
    syncOutput: modes.syncOutput,
    kittyKeyboard: modes.kittyKeyboard,
    mouse: modes.mouse,
    cursorVisible: modes.cursorVisible,
    focusReporting: modes.focusReporting,
  };
}

const base = profileId === 'unknown-conservative' ? unknownConservativeDefaults() : getProfile(profileId);
const profile = { ...base, columns: 120, rows: 40 };
const stdin = new FakeStdin();
const stdout = { columns: 120, rows: 40, isTTY: true };
const vt = new VirtualTerminal(profile);
const stream = new VtStream(vt);
const channel = createFakeChannel();
const diagnostics: unknown[] = [];

const coordinator = createTuiV2Coordinator({
  channel,
  stdin,
  stdout,
  stream,
  profile,
  clock: realClock,
  welcomeText: 'welcome-to-skeleton',
  attachProcessHandlers: true, // real process host: signal/error scenarios
  onDiagnostic: (d) => diagnostics.push(d),
});

const checks: Record<string, boolean> = {};

async function runConversationScript(): Promise<void> {
  checks.welcomeSeen = await waitFor(() => screenText(vt).includes('welcome-to-skeleton'));
  // Editor echo + submit through the real stdin path.
  stdin.write('hello skeleton');
  checks.echoSeen = await waitFor(() => screenText(vt).includes('hello skeleton'));
  channel.onSubmit = () => {
    channel.startAssistant('Hello');
  };
  stdin.write('\r');
  checks.userRowSeen = await waitFor(() => screenText(vt).includes('hello skeleton'));
  // Stream growth in place (chunks merge through the streaming controller).
  for (const chunk of [', ', 'stream', ' grows', ' here']) {
    channel.appendAssistant(chunk);
    await sleep(40);
  }
  channel.settleAssistant();
  checks.streamSeen = await waitFor(() => screenText(vt).includes('stream grows here'));
  // Tool card: running -> result.
  const tool = channel.addToolRow('bash', '{"cmd":"ls"}');
  checks.toolRunningSeen = await waitFor(() => screenText(vt).includes('bash'));
  channel.settleTool(tool, 'file-a.txt');
  checks.toolResultSeen = await waitFor(() => screenText(vt).includes('file-a.txt'));
}

async function writeReport(extra: Record<string, unknown>): Promise<void> {
  const report = {
    scenario,
    profileId,
    checks,
    vtModesAfterStop: defaultModes(vt),
    lifecycleState: coordinator.phase,
    stdinRawModes: stdin.rawModes,
    gridTextSample: screenText(vt).slice(0, 400),
    diagnostics: coordinator.diagnostics(),
    coordinatorDiagnostics: diagnostics.length,
    ...extra,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

await coordinator.start();

if (scenario === 'normal') {
  await runConversationScript();
  await coordinator.stop('user-exit');
  await coordinator.awaitStop();
  checks.stoppedClean = coordinator.phase === 'stopped';
  checks.modesRestored =
    defaultModes(vt).alternateScreen === false && defaultModes(vt).rawInput === false;
  await writeReport({ exit: 'clean' });
  const failed = Object.values(checks).some((ok) => !ok);
  process.exit(failed ? 1 : 0);
} else if (scenario === 'sigterm') {
  checks.welcomeSeen = await waitFor(() => screenText(vt).includes('welcome-to-skeleton'));
  process.stdout.write('READY\n');
  const stopped = await waitFor(() => coordinator.phase === 'stopped', 15000);
  checks.sigtermStopped = stopped;
  checks.modesRestored = defaultModes(vt).alternateScreen === false;
  await writeReport({ exit: 'sigterm' });
  process.exit(stopped && checks.welcomeSeen ? 0 : 1);
} else if (scenario === 'error') {
  checks.welcomeSeen = await waitFor(() => screenText(vt).includes('welcome-to-skeleton'));
  setTimeout(() => {
    throw new Error('injected skeleton fault');
  }, 25);
  const stopped = await waitFor(() => coordinator.phase === 'stopped', 15000);
  checks.errorStopped = stopped;
  checks.modesRestored = defaultModes(vt).alternateScreen === false;
  await writeReport({ exit: 'error' });
  process.exit(stopped ? 3 : 1);
} else {
  console.error(`skeleton-child: unknown scenario '${scenario}'`);
  process.exit(2);
}
