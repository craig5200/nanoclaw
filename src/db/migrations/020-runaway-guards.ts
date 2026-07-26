import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-group runaway guards.
 *
 * The Agent SDK accepts `maxBudgetUsd` and `maxTurns` and enforces both
 * harness-side (the query stops and returns `error_max_budget_usd` /
 * `error_max_turns`). Upstream passes neither, so nothing bounds a busy
 * agent loop: the host sweep kills on heartbeat *silence*, and a runaway is
 * maximally noisy, so it never trips.
 *
 * Both columns are nullable. NULL means "use the instance default" (see
 * src/config.ts) rather than "unbounded" — this is a safety guard, so the
 * default is on. An explicit 0 disables the guard.
 */
export const migration020: Migration = {
  version: 20,
  name: 'runaway-guards',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN max_budget_usd REAL').run();
    db.prepare('ALTER TABLE container_configs ADD COLUMN max_turns INTEGER').run();
  },
};
