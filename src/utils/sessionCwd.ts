import { homedir } from 'node:os'
import { resolve } from 'node:path'

/**
 * Workspace/session visibility comparison shared by UI hosts. Container roots
 * (HOME, drive roots and UNC share roots) only match exactly; ordinary project
 * paths match in either ancestor direction.
 */
export function sessionCwdMatches(
  stateCwd: string,
  headerCwd: string,
  caseInsensitive: boolean = process.platform === 'win32',
): boolean {
  const normalize = (value: string): string => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
    return caseInsensitive ? normalized.toLowerCase() : normalized
  }
  const cwd = normalize(stateCwd)
  const recorded = normalize(headerCwd)
  if (recorded === '' || cwd === '') return false
  const home = normalize(homedir())
  const isContainer = (path: string): boolean =>
    (home !== '' && path === home)
    || /^[a-z]:$/i.test(path)
    || /^\/\/[^/]+\/[^/]+$/.test(path)
    || /^\/\/\?\/[a-z]:$/i.test(path)
    || /^\/\/\?\/unc\/[^/]+\/[^/]+$/.test(path)
  if (isContainer(cwd) || isContainer(recorded)) return recorded === cwd
  return recorded === cwd || recorded.startsWith(`${cwd}/`) || cwd.startsWith(`${recorded}/`)
}

/** Normalize one local target path without following filesystem links. */
export function normalizedSessionCwd(value: string): string {
  return resolve(value)
}
