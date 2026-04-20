/**
 * v0.14.0 — no-op stub for gapless version sequencing.
 *
 * v0.14.0's ship (VERSION bump, shell-jobs) shipped only non-runtime-migration
 * changes: new handler type, worker abort-path fix, new MCP operation, all
 * covered by the existing schema + code flow. No DB migration was needed and
 * no migration module was produced at the time.
 *
 * v0.15.0 adds subagent_* tables via its own orchestrator. To keep the
 * migration registry's version sequence gapless (so future `upgrade` logic
 * can iterate min→max without hitting an unexpected gap), we ship this
 * explicit no-op migration rather than leaving a hole in the version series.
 *
 * Idempotent: running it multiple times is the same as running it once.
 */

import type { Migration, OrchestratorOpts, OrchestratorResult } from './types.ts';
import { appendCompletedMigration } from '../../core/preferences.ts';

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  const phases = [{ name: 'noop', status: 'complete' as const, detail: 'no runtime migration for v0.14.0' }];
  if (!opts.dryRun) {
    try {
      appendCompletedMigration({ version: '0.14.0', status: 'complete' });
    } catch {
      // best-effort
    }
  }
  return { version: '0.14.0', status: 'complete', phases };
}

export const v0_14_0: Migration = {
  version: '0.14.0',
  featurePitch: {
    headline: 'v0.14.0 no-op migration stub — shipped with shell-jobs.',
    description: 'v0.14.0 shipped new shell-job handler type + worker abort-path fix. No DB migration required.',
  },
  orchestrator,
};
