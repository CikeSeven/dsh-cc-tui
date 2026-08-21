/** Fake-only terminal writer used by the offline baseline capture. */
import { createHash } from 'node:crypto'

import type { TerminalControlOperation } from '../../src/tui-v2/terminal/writer.js'
import { encodeLifecycleOperation } from '../../src/tui-v2/terminal/writer.js'
import { isTrustedControlSequence } from '../../src/tui-v2/terminal/ansi.js'
import type { SideEffectSpy } from './side-effect-spy.js'
import type { FakeTerminalWriter } from './contract.js'

export interface FakeTerminalWriterOptions {
  readonly sideEffects?: SideEffectSpy
  readonly onBytes?: (data: string) => void
}

export interface FakeTerminalWriterState {
  readonly controls: readonly TerminalControlOperation[]
  readonly resets: number
  readonly bytes: number
  readonly ansiBytesHash: string
}

/**
 * A memory-only writer. It deliberately does not implement Writable and never
 * consults process.stdout/process.stderr. `onBytes` is an injected fake VT
 * sink, not a stream owned by the process.
 */
export class MemoryFakeTerminalWriter implements FakeTerminalWriter {
  readonly writes: string[] = []
  readonly controls: TerminalControlOperation[] = []
  private resetCount = 0
  private byteCount = 0
  private hash = createHash('sha256')
  private readonly sideEffects: SideEffectSpy | undefined
  private readonly onBytes: ((data: string) => void) | undefined

  constructor(options: FakeTerminalWriterOptions = {}) {
    this.sideEffects = options.sideEffects
    this.onBytes = options.onBytes
  }

  write(data: string): void {
    if (typeof data !== 'string') throw new TypeError('fake terminal writer data must be a string')
    this.writes.push(data)
    this.byteCount += Buffer.byteLength(data, 'utf8')
    this.hash.update(data, 'utf8')
    this.sideEffects?.recordFakeWriterWrite()
    this.onBytes?.(data)
  }

  writeControl(operation: TerminalControlOperation): void {
    if (operation === null || typeof operation !== 'object') throw new TypeError('fake terminal control must be an object')
    let bytes = ''
    switch (operation.kind) {
      case 'lifecycle':
        bytes = encodeLifecycleOperation(operation.operation)
        break
      case 'sequence':
        if (!isTrustedControlSequence(operation.sequence)) {
          throw new TypeError('fake terminal writer rejected untrusted control sequence')
        }
        bytes = operation.sequence
        break
      case 'query':
        // Query responses require a live terminal and are explicitly forbidden
        // in an offline baseline capture.
        throw new Error('offline baseline capture cannot issue terminal queries')
      default:
        throw new TypeError('fake terminal writer received an unknown control operation')
    }
    this.controls.push(operation)
    this.sideEffects?.recordFakeWriterControl()
    if (bytes !== '') this.write(bytes)
  }

  reset(): void {
    this.resetCount += 1
    this.sideEffects?.recordReset()
    this.writes.length = 0
    this.controls.length = 0
    this.byteCount = 0
    this.hash = createHash('sha256')
  }

  get state(): FakeTerminalWriterState {
    return {
      controls: [...this.controls],
      resets: this.resetCount,
      bytes: this.byteCount,
      ansiBytesHash: this.hash.copy().digest('hex'),
    }
  }
}

export function createFakeTerminalWriter(options: FakeTerminalWriterOptions = {}): MemoryFakeTerminalWriter {
  return new MemoryFakeTerminalWriter(options)
}
