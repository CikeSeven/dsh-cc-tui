#!/usr/bin/env node
/**
 * Copy vendored pi-tui license artifacts into the compiled output so the npm
 * tarball ships them (WP-03a; tsc only emits js/d.ts). Runs as the last step
 * of the `compile` script.
 *
 * Copies src/tui-v2/vendor/pi-tui/{LICENSE,NOTICE,PATCH-LEDGER.md,VENDOR-MANIFEST.json}
 * to lib/types/tui-v2/vendor/pi-tui/. Fails loudly when the vendor tree or the
 * compiled output directory is missing, so a broken vendor state can never
 * silently produce a tarball without the license files.
 */
import { copyFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const vendorSrc = path.join(repoRoot, 'src', 'tui-v2', 'vendor', 'pi-tui')
const vendorOut = path.join(repoRoot, 'lib', 'types', 'tui-v2', 'vendor', 'pi-tui')

const FILES = ['LICENSE', 'NOTICE', 'PATCH-LEDGER.md', 'VENDOR-MANIFEST.json']

async function main() {
  if (!(await stat(vendorOut).catch(() => null))?.isDirectory()) {
    throw new Error(
      `compiled vendor directory missing: ${vendorOut} (run tsc first / check the vendored tree exists)`,
    )
  }
  for (const name of FILES) {
    const src = path.join(vendorSrc, name)
    if (!(await stat(src).catch(() => null))?.isFile()) {
      throw new Error(`vendored license artifact missing: ${src}`)
    }
    await copyFile(src, path.join(vendorOut, name))
  }
  console.log(`copied ${FILES.length} vendor license artifacts -> ${path.relative(repoRoot, vendorOut)}`)
}

await main()
