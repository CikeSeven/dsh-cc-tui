import { basename, isAbsolute, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type { WorkspaceHostCapability } from '../controllers/workspace-flow.js'

function localTarget(cwd: string) {
  const absolute = resolve(cwd)
  return {
    uri: pathToFileURL(absolute).href,
    cwd: absolute,
    label: basename(absolute) || absolute,
    description: absolute,
    kind: 'local' as const,
    badge: 'LOCAL',
  }
}

function parseReference(reference: string, currentCwd: string) {
  if (isAbsolute(reference)) return localTarget(reference)
  try {
    const parsed = new URL(reference)
    if (parsed.protocol === 'file:') return localTarget(fileURLToPath(parsed))
    if (parsed.protocol !== '') return undefined
  } catch {
    // Relative/local references use the current cwd below.
  }
  return localTarget(resolve(currentCwd, reference))
}

/** Local-only workspace fallback for direct embedders without a host service. */
export function createLocalWorkspaceFallback(): WorkspaceHostCapability {
  return {
    async list(currentCwd) {
      return [localTarget(currentCwd)]
    },
    async resolve(reference, currentCwd) {
      return parseReference(reference, currentCwd ?? process.cwd())
    },
    commands: () => [],
    runCommand: async () => undefined,
  }
}
