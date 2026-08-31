#!/usr/bin/env node
/**
 * Instrument the DEV react-reconciler for nested-update (#185) diagnosis.
 * Edits node_modules/react-reconciler/cjs/react-reconciler.development.js in
 * place (original saved next to it as .instr-orig); re-applies from the
 * pristine backup on every run so edits to this script take effect.
 *
 * Patches:
 *  1. commit-end counter (commitRootImpl): after every commit appends
 *     nestedUpdateCount to __traj and `lanes:remaining` to __lanes, tracks
 *     __maxNested, logs [NESTED++] once the count reaches 3.
 *  2. getRootForUpdatedFiber throw site: records the source fiber's nearest
 *     function-component name into __ics and logs [NESTED-THROW].
 *  3. sets globalThis.__recPatched = true so repro scripts can assert the
 *     patch is loaded.
 *
 * Run: node scripts/instr-nested-updates.mjs   (then run a repro with
 * NODE_ENV=development; production builds are untouched)
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'

const file = 'node_modules/react-reconciler/cjs/react-reconciler.development.js'
const MARKER = '__INSTR_NESTED_V3__'

if (!existsSync(file + '.instr-orig')) copyFileSync(file, file + '.instr-orig')
// Always start from the pristine copy so script edits apply cleanly.
let src = readFileSync(file + '.instr-orig', 'utf8')

// 1. commit-end counter — exact anchor from commitRootImpl
const counterAnchor = `        0 !== (endTime & 261930) && 0 !== (remainingLanes & 42)
          ? ((nestedUpdateScheduled = !0),
            startViewTransitionStartTime === rootWithNestedUpdates
              ? nestedUpdateCount++
              : ((nestedUpdateCount = 0),
                (rootWithNestedUpdates = startViewTransitionStartTime)))
          : (nestedUpdateCount = 0);`
const counterPatched = counterAnchor + `
        (globalThis.__traj ??= []).push(nestedUpdateCount);
        (globalThis.__lanes ??= []).push(endTime + ':' + remainingLanes);
        if (nestedUpdateCount > (globalThis.__maxNested ?? 0)) globalThis.__maxNested = nestedUpdateCount;
        if (nestedUpdateCount >= 3) console.error('[NESTED++] count=' + nestedUpdateCount + ' lanes=' + endTime + ' remaining=' + remainingLanes);`
if (!src.includes(counterAnchor)) {
  console.error('instr-nested-updates: counter anchor not found — reconciler drifted?')
  process.exit(1)
}
src = src.replace(counterAnchor, counterPatched)

// 2. residue-source tracker — who dispatches while work is in flight.
//    (a) commit-phase dispatch: executionContext & CommitContext (≠ 0)
//    (b) interleaved between-slices arrival: root === workInProgressRoot
//        while NOT in render/commit execution (timer callback between slices)
//    Both land in pendingLanes after the commit → the remainingLanes residue
//    that the commit-end rule counts as a nested update.
const schedAnchor = `      markRootUpdated$1(root, lane);`
const schedPatched = `      try {
        var __ctx = (executionContext & 4) !== 0 ? 'commit'
          : (root === workInProgressRoot && (executionContext & 2) === 0) ? 'interleaved'
          : null;
        if (__ctx !== null) {
          var __m = (globalThis.__residue ??= new Map());
          var __n = getComponentNameFromFiber(fiber) || ('tag' + fiber.tag);
          var __s = new Error('residue-site').stack || '';
          // key by the first app (non-reconciler, non-node) stack frame so
          // distinct setState sites on the same fiber stay separate
          var __f = (__s.split('\\n').find(function (l) {
            return l.includes('/src/') && !l.includes('instr-nested')
          }) || '').trim().replace(/^at\s+/, '');
          var __k = __ctx + ':' + __n + ':lane' + lane + ' @' + __f;
          var __e = __m.get(__k);
          if (__e === undefined) __m.set(__k, { count: 1, stack: __s });
          else __e.count++;
        }
      } catch (e) {}
      markRootUpdated$1(root, lane);`
if (!src.includes(schedAnchor)) {
  console.error('instr-nested-updates: schedule anchor not found — reconciler drifted?')
  process.exit(1)
}
src = src.replace(schedAnchor, schedPatched)

// 3. throw site — record the victim (source fiber's component name)
const throwAnchor = `    function getRootForUpdatedFiber(sourceFiber) {
      if (nestedUpdateCount > NESTED_UPDATE_LIMIT)`
const throwPatched = `    function getRootForUpdatedFiber(sourceFiber) {
      if (nestedUpdateCount > NESTED_UPDATE_LIMIT) {
        try {
          globalThis.__ics = globalThis.__ics || new Map();
          let f = sourceFiber, nm = '?';
          while (f) { const t = f.elementType; if (typeof t === 'function') { nm = t.displayName || t.name || '?'; break; } f = f.return; }
          globalThis.__ics.set('THROW@' + nm, { count: nestedUpdateCount, stack: new Error('throw-site').stack, ctx: 0 });
          console.error('[NESTED-THROW] source=' + nm + ' count=' + nestedUpdateCount);
        } catch (e) {}
      }
      if (nestedUpdateCount > NESTED_UPDATE_LIMIT)`
if (!src.includes(throwAnchor)) {
  console.error('instr-nested-updates: throw anchor not found — reconciler drifted?')
  process.exit(1)
}
src = src.replace(throwAnchor, throwPatched)

src += `\n/* ${MARKER} */\nglobalThis.__recPatched = true;\n`
writeFileSync(file, src)
console.log('instr-nested-updates: patched', file, '(original at .instr-orig)')
