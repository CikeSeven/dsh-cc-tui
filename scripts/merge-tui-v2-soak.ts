import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface SoakArtifact {
  readonly schemaVersion?: number
  readonly kind?: string
  readonly status?: string
  readonly gateEligible?: boolean
  readonly coverageMode?: string
  readonly profile?: string
  readonly seed?: number
  readonly node?: string
  readonly runnerId?: string
  readonly terminalType?: string
  readonly terminal?: {
    readonly type?: string
    readonly realPty?: boolean
    readonly required?: boolean
    readonly nodePtyVersion?: string
  }
  readonly requested?: { readonly mode?: string; readonly minutes?: number }
  readonly activeDurationMs?: number
  readonly gates?: { readonly fullGate?: boolean; readonly memory?: boolean }
  readonly metrics?: { readonly memory?: { readonly evaluation?: { readonly eligible?: boolean; readonly pass?: boolean } } }
  readonly startedAt?: string
  readonly endedAt?: string
}

interface ChainSegment {
  readonly segment: number
  readonly artifactPath: string
  readonly artifactSha256: string
  readonly artifactStatus: string
  readonly coverageMode: string
  readonly runnerId: string
  readonly nodeVersion: string
  readonly requestedMinutes: number
  readonly activeDurationMs: number
  readonly startedAt: string
  readonly endedAt: string
}

interface ChainArtifact {
  readonly schemaVersion: 1
  readonly kind: 'tui-v2-soak-chain'
  readonly status: 'pass'
  readonly runId: string
  readonly host: string
  readonly node: string
  readonly profile: string
  readonly seed: number
  readonly expectedSegments: number
  readonly expectedTotalMinutes: number
  readonly segments: readonly ChainSegment[]
  readonly previousChainSha256: string | null
  readonly chainSha256: string
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function usage(): never {
  throw new Error([
    'Usage:',
    '  --mode chain --input soak.json --output chain.json --run-id ID --host HOST --node NODE',
    '    --segment N --expected-segments N --segment-minutes N [--previous chain.json]',
    '  --mode aggregate --directory DIR --output aggregate.json --expected-segments N',
    '    --expected-total-minutes N --expected-hosts a,b,c --expected-nodes 22.19,24',
  ].join('\n'))
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`)
    const key = arg.slice(2)
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    args[key] = value
  }
  if (args.mode !== 'chain' && args.mode !== 'aggregate') usage()
  return args
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
}

function assertPositiveInt(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`)
  return parsed
}

function assertFinitePositive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`)
  return value
}

function validateSoak(value: SoakArtifact, segmentMinutes: number): void {
  if (value.schemaVersion !== 1 || value.kind !== 'tui-v2-soak') throw new Error('input is not a schemaVersion 1 tui-v2 soak artifact')
  if (value.status !== 'pass' || value.gateEligible !== true) throw new Error('input soak is not a passing gate-eligible artifact')
  if (
    value.terminalType !== 'real-pty' || value.terminal?.type !== 'real-pty' ||
    value.terminal.realPty !== true || value.terminal.required !== true ||
    value.terminal.nodePtyVersion !== '1.1.0'
  ) {
    throw new Error('input soak is not required real-PTY@1.1.0 evidence')
  }
  if (value.coverageMode !== 'full-duration' || value.gates?.fullGate !== true || value.gates.memory !== true) {
    throw new Error('input soak did not pass the full-duration gate')
  }
  if (value.metrics?.memory?.evaluation?.eligible !== true || value.metrics.memory.evaluation.pass !== true) {
    throw new Error('input soak memory evaluation is missing or failed')
  }
  if (value.requested?.mode !== 'duration' || value.requested.minutes !== segmentMinutes) {
    throw new Error(`input soak duration must be exactly ${segmentMinutes} minutes`)
  }
  if (
    typeof value.profile !== 'string' || value.profile === '' ||
    !Number.isSafeInteger(value.seed) ||
    typeof value.runnerId !== 'string' || value.runnerId === '' ||
    typeof value.node !== 'string' || value.node === ''
  ) throw new Error('input soak identity is incomplete')
  const activeDurationMs = assertFinitePositive(value.activeDurationMs, 'input activeDurationMs')
  if (activeDurationMs < segmentMinutes * 60_000) throw new Error('input soak ended before its requested duration')
  if (typeof value.startedAt !== 'string' || typeof value.endedAt !== 'string') throw new Error('input soak timestamps are missing')
}

function chainDigest(value: Omit<ChainArtifact, 'chainSha256'>): string {
  return sha256(JSON.stringify(value))
}

async function makeChain(args: Record<string, string>): Promise<ChainArtifact> {
  const input = args.input
  const output = args.output
  const runId = args['run-id']
  const host = args.host
  const node = args.node
  if (!input || !output || !runId || !host || !node) usage()
  const segment = assertPositiveInt(args.segment ?? '', '--segment')
  const expectedSegments = assertPositiveInt(args['expected-segments'] ?? '', '--expected-segments')
  const segmentMinutes = assertFinitePositive(Number(args['segment-minutes']), '--segment-minutes')
  if (segment > expectedSegments) throw new Error('segment exceeds expected-segments')
  const soak = await readJson(path.resolve(input)) as SoakArtifact
  validateSoak(soak, segmentMinutes)
  if (!(soak.node as string).startsWith(`v${node}`)) throw new Error(`input Node ${soak.node} does not match matrix Node ${node}`)
  const artifactBytes = await readFile(path.resolve(input))
  const artifactPath = path.resolve(input)
  const current: ChainSegment = {
    segment,
    artifactPath,
    artifactSha256: sha256(artifactBytes),
    artifactStatus: soak.status as string,
    coverageMode: soak.coverageMode as string,
    runnerId: soak.runnerId as string,
    nodeVersion: soak.node as string,
    requestedMinutes: segmentMinutes,
    activeDurationMs: soak.activeDurationMs as number,
    startedAt: soak.startedAt as string,
    endedAt: soak.endedAt as string,
  }
  let previous: ChainArtifact | null = null
  let previousHash: string | null = null
  if (args.previous !== undefined) {
    previous = await readJson(path.resolve(args.previous)) as ChainArtifact
    const previousBytes = await readFile(path.resolve(args.previous))
    previousHash = sha256(previousBytes)
    if (previous.schemaVersion !== 1 || previous.kind !== 'tui-v2-soak-chain' || previous.status !== 'pass') throw new Error('previous artifact is not a passing soak chain')
    if (
      previous.runId !== runId || previous.host !== host || previous.node !== node ||
      previous.expectedSegments !== expectedSegments || previous.profile !== soak.profile || previous.seed !== soak.seed
    ) {
      throw new Error('previous chain identity/segment contract does not match')
    }
    const { chainSha256: previousDigest, ...previousBody } = previous
    if (previousDigest !== chainDigest(previousBody)) throw new Error('previous chain SHA-256 does not match its body')
    if (previous.segments.length !== segment - 1) throw new Error('previous chain is not immediately contiguous')
    for (let index = 0; index < previous.segments.length; index += 1) {
      if (previous.segments[index]!.segment !== index + 1) throw new Error('previous chain has a segment gap or duplicate')
    }
  } else if (segment !== 1) {
    throw new Error('segment 1 requires no previous chain; later segments require --previous')
  }
  const segments = [...(previous?.segments ?? []), current]
  const body: Omit<ChainArtifact, 'chainSha256'> = {
    schemaVersion: 1,
    kind: 'tui-v2-soak-chain',
    status: 'pass',
    runId,
    host,
    node,
    profile: soak.profile as string,
    seed: soak.seed as number,
    expectedSegments,
    expectedTotalMinutes: expectedSegments * segmentMinutes,
    segments,
    previousChainSha256: previousHash,
  }
  const result: ChainArtifact = { ...body, chainSha256: chainDigest(body) }
  await writeAtomic(path.resolve(output), result)
  return result
}

async function walkJsonFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await walkJsonFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.json')) result.push(full)
  }
  return result.sort()
}

function validateChain(value: ChainArtifact, expectedSegments: number): void {
  if (value.schemaVersion !== 1 || value.kind !== 'tui-v2-soak-chain' || value.status !== 'pass') throw new Error('invalid chain schema/status')
  if (value.expectedSegments !== expectedSegments || value.segments.length !== expectedSegments) throw new Error(`chain ${value.host}/${value.node} has wrong segment count`)
  const { chainSha256: digest, ...body } = value
  if (digest !== chainDigest(body)) throw new Error(`chain ${value.host}/${value.node} hash mismatch`)
  for (let index = 0; index < value.segments.length; index += 1) {
    const segment = value.segments[index]!
    if (segment.segment !== index + 1 || segment.artifactStatus !== 'pass' || segment.coverageMode === 'smoke') throw new Error(`chain ${value.host}/${value.node} has invalid segment ${index + 1}`)
    if (segment.artifactSha256.length !== 64 || !/^[0-9a-f]+$/u.test(segment.artifactSha256)) throw new Error('chain source hash is invalid')
  }
}

async function makeAggregate(args: Record<string, string>): Promise<Record<string, unknown>> {
  const directory = args.directory
  const output = args.output
  if (!directory || !output) usage()
  const expectedSegments = assertPositiveInt(args['expected-segments'] ?? '', '--expected-segments')
  const expectedTotalMinutes = assertFinitePositive(Number(args['expected-total-minutes']), '--expected-total-minutes')
  const expectedHosts = new Set((args['expected-hosts'] ?? '').split(',').map(item => item.trim()).filter(Boolean))
  const expectedNodes = new Set((args['expected-nodes'] ?? '').split(',').map(item => item.trim()).filter(Boolean))
  if (expectedHosts.size === 0 || expectedNodes.size === 0) usage()
  const errors: string[] = []
  const candidates: ChainArtifact[] = []
  for (const file of await walkJsonFiles(path.resolve(directory))) {
    try {
      const value = await readJson(file) as ChainArtifact
      if (value.kind !== 'tui-v2-soak-chain') continue
      // Downloads contain every intermediate continuation. Only the terminal
      // chain is an aggregate candidate; intermediate chains remain evidence
      // and were hash-verified by the next segment when it started.
      if (!Array.isArray(value.segments) || value.segments.length !== expectedSegments) continue
      validateChain(value, expectedSegments)
      const minutes = value.segments.reduce((sum, segment) => sum + segment.requestedMinutes, 0)
      if (minutes !== expectedTotalMinutes) throw new Error(`chain total minutes ${minutes} != ${expectedTotalMinutes}`)
      candidates.push(value)
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const identity = new Map<string, ChainArtifact>()
  for (const candidate of candidates) {
    if (!expectedHosts.has(candidate.host) || !expectedNodes.has(candidate.node)) continue
    const key = `${candidate.host}\0${candidate.node}`
    if (identity.has(key)) errors.push(`duplicate complete chain for ${candidate.host}/${candidate.node}`)
    else identity.set(key, candidate)
  }
  for (const host of expectedHosts) for (const node of expectedNodes) {
    if (!identity.has(`${host}\0${node}`)) errors.push(`missing complete chain for ${host}/${node}`)
  }
  const result = {
    schemaVersion: 1,
    kind: 'tui-v2-soak-aggregate',
    status: errors.length === 0 ? 'pass' : 'fail',
    expectedSegments,
    expectedTotalMinutes,
    expectedHosts: [...expectedHosts].sort(),
    expectedNodes: [...expectedNodes].sort(),
    chains: [...identity.values()].map(chain => ({ host: chain.host, node: chain.node, runId: chain.runId, chainSha256: chain.chainSha256, segments: chain.segments.length })),
    errors,
  }
  await writeAtomic(path.resolve(output), result)
  return result
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2)
  let output = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'tui-v2', 'merge.json')
  const outputIndex = rawArgs.indexOf('--output')
  if (outputIndex >= 0 && rawArgs[outputIndex + 1]) output = path.resolve(rawArgs[outputIndex + 1]!)
  try {
    const args = parseArgs(rawArgs)
    const result = args.mode === 'chain' ? await makeChain(args) : await makeAggregate(args)
    console.log(`tui-v2 soak merge artifact written to ${path.resolve(output)} (status=${result.status})`)
    return result.status === 'pass' ? 0 : 1
  } catch (error) {
    const result = { schemaVersion: 1, kind: 'tui-v2-soak-merge', status: 'fail', errors: [String(error instanceof Error ? error.message : error)] }
    await writeAtomic(path.resolve(output), result)
    console.error(`tui-v2 soak merge failed: ${result.errors[0]}`)
    return 1
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = await main()
