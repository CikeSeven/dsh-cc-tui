import { readFile } from 'node:fs/promises'

const input = await new Promise((resolve, reject) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { value += chunk })
  process.stdin.on('end', () => resolve(value))
  process.stdin.on('error', reject)
})

const reports = JSON.parse(input)
// npm 10 emits an array while npm 11 emits an object keyed by package name.
const report = Array.isArray(reports) ? reports[0] : Object.values(reports)[0]
if (report === undefined || !Array.isArray(report.files)) {
  throw new Error('npm pack did not return a package file list')
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const packed = new Set(report.files.map(file => file.path.replaceAll('\\', '/')))
const offlineBaselineFiles = [...packed].filter(path => path === 'tools' || path.startsWith('tools/'))
if (offlineBaselineFiles.length > 0) {
  throw new Error(`package unexpectedly contains offline baseline tools: ${offlineBaselineFiles.join(', ')}`)
}
const retiredPathToken = (...parts) => parts.join('')
const retiredRuntimePaths = [...packed].filter(path => {
  const roots = [retiredPathToken('i', 'nk'), 'components', 'screens', retiredPathToken('native-ts/', 'yo', 'ga-layout')]
  return roots.some(root => new RegExp(`^(?:lib/types/)?${root}(?:/|$)`, 'u').test(path))
    || new RegExp(`^lib/types/(?:ui|${retiredPathToken('force-', 'production-react')}|customTheme|theme|trajectoryPrefs)(?:\\.|$)`, 'u').test(path)
    || /^lib\/types\/(?:bootstrap\/state|hooks\/useBlink|sessions\/format|utils\/sliceAnsi)(?:\.|$)/u.test(path)
    || /^lib\/types\/(?:cc\/(?:markdown|cliHighlight|hyperlink|terminal|figures|format|spinnerVerbs)|trajectory\/(?:format|motion|query))(?:\.|$)/u.test(path)
})
if (retiredRuntimePaths.length > 0) {
  throw new Error(`package unexpectedly contains retired renderer paths: ${retiredRuntimePaths.join(', ')}`)
}
const retiredDependencies = new Set([
  retiredPathToken('re', 'act'), retiredPathToken('re', 'act-', 'reconciler'),
  retiredPathToken('yo', 'ga'), retiredPathToken('yo', 'ga-layout'),
])
for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (retiredDependencies.has(name)) throw new Error(`package manifest contains retired runtime dependency ${section}:${name}`)
  }
}
const targets = new Set()

const addTarget = value => {
  if (typeof value === 'string') targets.add(value.replace(/^\.\//u, ''))
}

addTarget(manifest.main)
addTarget(manifest.types)
for (const target of Object.values(manifest.bin ?? {})) addTarget(target)

const collectExports = value => {
  if (typeof value === 'string') {
    addTarget(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const nested of Object.values(value)) collectExports(nested)
}
collectExports(manifest.exports)

const missing = [...targets].filter(target => !packed.has(target))
if (missing.length > 0) {
  throw new Error(`package exports missing from tarball: ${missing.join(', ')}`)
}
for (const presetFile of [
  'presets/liangshen/agent.cordis.yml',
  'presets/liangshen/preset.yml',
  'presets/liangshen/.dsh-tui-managed.json',
  'presets/liangshen/tool-bootstrap.mjs',
]) {
  if (!packed.has(presetFile)) throw new Error(`packaged preset file missing from tarball: ${presetFile}`)
}
if ([...packed].some(path => path.startsWith('src/'))) {
  throw new Error('npm package unexpectedly contains TypeScript sources')
}
if (packed.has('lib/invariant.js')) {
  throw new Error('npm package contains the obsolete hand-built invariant entry')
}
const retiredRuntimeNames = [
  retiredPathToken('re', 'act'), retiredPathToken('re', 'act-', 'reconciler'),
  retiredPathToken('yo', 'ga'), retiredPathToken('yo', 'ga-layout'),
]
const retiredSpecifier = new RegExp(`(?:from\\s*|import\\s*\\()\\s*['"](?:${retiredRuntimeNames.join('|')})(?:/[^'"]*)?['"]`, 'u')
const retiredRelativePath = new RegExp(`(?:from\\s*|import\\s*\\()\\s*['"][^'"]*(?:/(?:${retiredPathToken('i', 'nk')}|screens|native-ts/${retiredPathToken('yo', 'ga-layout')})(?:/|\\.)|/ui\\.js)['"]`, 'u')
for (const file of packed) {
  if (!/^lib\/types\/.*\.(?:js|d\.ts)$/u.test(file)) continue
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  if (retiredSpecifier.test(source) || retiredRelativePath.test(source)) {
    throw new Error(`compiled package imports a retired renderer path: ${file}`)
  }
}

await import(new URL(`../${manifest.main}`, import.meta.url))
const invariant = await import(new URL('../lib/types/dsh-adapter/invariant.js', import.meta.url))
if (invariant.name !== 'dsh-tui-invariant' || typeof invariant.apply !== 'function') {
  throw new Error('compiled invariant entry does not expose the expected contract')
}

// WP-08a: the `./tui-v2` capability export is the versioned plugin surface —
// it must import cleanly from the compiled package and carry the SceneV2
// runtime anchors (and nothing stateful beyond them).
const tuiV2 = await import(new URL('../lib/types/tui-v2/index.js', import.meta.url))
if (tuiV2.SCENE_API_VERSION !== '2' || !Array.isArray(tuiV2.SUPPORTED_SCENE_API_VERSIONS)
  || tuiV2.SUPPORTED_SCENE_API_VERSIONS[0] !== '2') {
  throw new Error('compiled tui-v2 export does not expose the SceneV2 runtime anchors')
}

console.log(`package surface OK (${packed.size} files, ${targets.size} entry targets)`)
