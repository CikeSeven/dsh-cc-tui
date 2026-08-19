/**
 * Shared headless Chat harness for the tui-v2 testkit (WP-01).
 *
 * Replicates the established fake-TTY pattern from scripts/repro-ctrlc.tsx /
 * scripts/smoke.tsx: FakeStdout/FakeStderr (Writable, isTTY) + FakeStdin
 * (PassThrough, setRawMode noop) + render() from src/ui.js with a mock
 * channel + @xterm/headless as the terminal oracle. Never opens a real TTY.
 *
 * Callers MUST set process.env.FORCE_COLOR / DSH_TUI_LANG before invoking
 * createChatHarness(); src modules are imported lazily inside the factory so
 * the language pin takes effect before startup-lang resolution.
 */

export interface HarnessWrite {
  at: number
  bytes: number
}

export interface ChatHarness {
  cols: number
  rows: number
  channel: any
  /** Bump the mock channel: version++ then invoke all subscribe callbacks. */
  bump: () => void
  stdin: import('node:stream').PassThrough
  stdout: import('node:stream').Writable & { frames: number; writes: HarnessWrite[] }
  stderr: import('node:stream').Writable & { frames: number }
  /** Render <AlternateScreen><Chat/></AlternateScreen>; resolves to the instance. */
  render: () => Promise<{ unmount: () => void }>
  /** True when the xterm oracle's active buffer contains `s`. */
  screenHas: (s: string) => boolean
  /** The oracle's active buffer as plain text lines (0..rows), for hashing. */
  gridText: () => string
}

export interface ChatHarnessOptions {
  cols?: number
  rows?: number
  seedRows?: any[]
  onWrite?: (write: HarnessWrite) => void
}

export async function createChatHarness(options: ChatHarnessOptions = {}): Promise<ChatHarness> {
  const cols = options.cols ?? 120
  const rows = options.rows ?? 40

  const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { performance }] = await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../../../src/ui.js'),
    import('../../../src/screens/Chat.js'),
    import('../../../src/dsh-adapter/questions.js'),
    import('node:perf_hooks'),
  ])

  const term = new XTerm({ cols, rows, scrollback: 50, allowProposedApi: true })

  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    frames = 0
    writes: HarnessWrite[] = []
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
      const write = { at: performance.now(), bytes: String(chunk).length }
      this.frames++
      this.writes.push(write)
      options.onWrite?.(write)
      term.write(String(chunk), cb)
    }
  }
  class FakeStderr extends Writable {
    isTTY = true
    frames = 0
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) { this.frames++; cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }

  const listeners = new Set<() => void>()
  const channel: any = {
    version: 0,
    rows: options.seedRows ?? [],
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    mode: { plan: false },
    reasoningEffort: 'max',
    tokens: { input: 1, output: 1 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: Date.now(),
    lastUserText: '',
    pending: [],
    commandList: [],
    notifications: [],
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => {}, cancel: () => {}, clear: () => {},
    notify(msg: string) { channel.notifications.push(msg); bump() },
    listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
    loadOlder: () => {}, mcpStatus: () => [],
  }
  const bump = () => { channel.version++; for (const cb of listeners) cb() }

  const stdinObj = new FakeStdin()
  const stdout = new FakeStdout()
  const stderr = new FakeStderr()

  return {
    cols,
    rows,
    channel,
    bump,
    stdin: stdinObj,
    stdout,
    stderr,
    render: () =>
      render(
        <AlternateScreen>
          <Chat channel={channel} questionStore={new QuestionStore()} onExit={() => {}} />
        </AlternateScreen>,
        { stdout, stdin: stdinObj, stderr, exitOnCtrlC: false, patchConsole: false },
      ) as Promise<{ unmount: () => void }>,
    screenHas: (s: string) => {
      const buf = term.buffer.active
      for (let y = 0; y < rows; y++) {
        if ((buf.getLine(y)?.translateToString(true) ?? '').includes(s)) return true
      }
      return false
    },
    gridText: () => {
      const buf = term.buffer.active
      const lines: string[] = []
      for (let y = 0; y < rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
      return lines.join('\n')
    },
  }
}
