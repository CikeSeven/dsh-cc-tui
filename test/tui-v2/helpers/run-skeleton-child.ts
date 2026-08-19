/**
 * Shared runner for the WP-04 skeleton child (used by the walking-skeleton
 * test and `scripts/verify-tui-v2.ts --check skeleton`).
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'skeleton-child.ts');

export interface SkeletonChildReport {
  readonly scenario: string;
  readonly profileId: string;
  readonly checks: Record<string, boolean>;
  readonly vtModesAfterStop: Record<string, unknown>;
  readonly lifecycleState: string;
  readonly stdinRawModes: readonly boolean[];
  readonly gridTextSample: string;
  readonly diagnostics: unknown;
  readonly exit: string;
}

export interface SkeletonChildResult {
  readonly scenario: string;
  readonly exitCode: number | null;
  readonly report: SkeletonChildReport;
  readonly stderrTail: string;
}

export interface RunSkeletonChildOptions {
  readonly profileId?: string;
  readonly reportDir: string;
  /** Overall deadline; the child itself exits well before this. */
  readonly timeoutMs?: number;
}

export async function runSkeletonChild(
  scenario: 'normal' | 'sigterm' | 'error',
  options: RunSkeletonChildOptions,
): Promise<SkeletonChildResult> {
  const reportPath = join(options.reportDir, `skeleton-${scenario}-${options.profileId ?? 'kitty-sync'}.json`);
  const args = ['--import', 'tsx/esm', CHILD, scenario, reportPath, options.profileId ?? 'kitty-sync'];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdoutText = '';
  let stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutText += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
  });
  if (scenario === 'sigterm') {
    // Wait for the READY marker, then deliver the signal the lifecycle owns.
    const deadline = Date.now() + 30000;
    while (!stdoutText.includes('READY')) {
      if (Date.now() > deadline || child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`skeleton child '${scenario}' timed out`));
    }, options.timeoutMs ?? 60000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as SkeletonChildReport;
  return {
    scenario,
    exitCode,
    report,
    stderrTail: stderrText.slice(-2000),
  };
}
