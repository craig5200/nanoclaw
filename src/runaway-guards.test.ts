/**
 * Runaway guard wiring (unit + structural).
 *
 * Nothing bounds a *busy* agent loop upstream: the host sweep kills on
 * heartbeat silence and a runaway is maximally noisy, so it never trips. These
 * guards are the only hard ceiling, which makes their resolution rules worth
 * pinning down — a bug that silently resolves to "unbounded" removes the only
 * protection without failing anything.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { configFromDb } from './container-config.js';
import { DEFAULT_MAX_BUDGET_USD, DEFAULT_MAX_TURNS } from './config.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

const GROUP: AgentGroup = { id: 'ag-test', name: 'Test', folder: 'test' } as AgentGroup;

function row(over: Partial<ContainerConfigRow> = {}): ContainerConfigRow {
  return {
    agent_group_id: 'ag-test',
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    max_budget_usd: null,
    max_turns: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    updated_at: '2026-01-01',
    ...over,
  };
}

describe('runaway guard resolution', () => {
  it('defaults are generous enough that a normal errand never reaches them', () => {
    // These are circuit breakers, not task management. If either is ever
    // lowered to a value a real errand can hit, it stops being a safety net
    // and starts truncating legitimate work.
    expect(DEFAULT_MAX_BUDGET_USD).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_MAX_TURNS).toBeGreaterThanOrEqual(200);
  });

  it('NULL falls back to the instance default (guard is on, not off)', () => {
    const cfg = configFromDb(row(), GROUP);
    expect(cfg.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
    expect(cfg.maxTurns).toBe(DEFAULT_MAX_TURNS);
  });

  it('an explicit per-group value wins over the default', () => {
    const cfg = configFromDb(row({ max_budget_usd: 1.5, max_turns: 40 }), GROUP);
    expect(cfg.maxBudgetUsd).toBe(1.5);
    expect(cfg.maxTurns).toBe(40);
  });

  it('an explicit 0 disables the guard and is not mistaken for unset', () => {
    const cfg = configFromDb(row({ max_budget_usd: 0, max_turns: 0 }), GROUP);
    expect(cfg.maxBudgetUsd).toBe(0);
    expect(cfg.maxTurns).toBe(0);
  });

  it('a corrupt negative value falls back to the default rather than removing the guard', () => {
    const cfg = configFromDb(row({ max_budget_usd: -1, max_turns: -5 }), GROUP);
    expect(cfg.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD);
    expect(cfg.maxTurns).toBe(DEFAULT_MAX_TURNS);
  });
});

describe('provider wiring (structural)', () => {
  // Driving a real sdkQuery needs a live gateway and a container, so guard the
  // wiring by reading the source — same idiom as container-runner.test.ts.
  const providerSrc = fs.readFileSync(
    path.join(process.cwd(), 'container', 'agent-runner', 'src', 'providers', 'claude.ts'),
    'utf-8',
  );

  it('passes both guards into the SDK query options', () => {
    expect(providerSrc).toMatch(/maxBudgetUsd: this\.maxBudgetUsd/);
    expect(providerSrc).toMatch(/maxTurns: this\.maxTurns/);
  });

  it('maps 0 to undefined so a disabled guard is not a zero ceiling', () => {
    // `maxBudgetUsd: 0` would stop the query on the first token. Disabled must
    // mean "send no ceiling", not "send a ceiling of nothing".
    expect(providerSrc).toMatch(/this\.maxBudgetUsd = options\.maxBudgetUsd \? options\.maxBudgetUsd : undefined/);
    expect(providerSrc).toMatch(/this\.maxTurns = options\.maxTurns \? options\.maxTurns : undefined/);
  });

  it('translates both trip subtypes into user-facing text', () => {
    expect(providerSrc).toContain("m.subtype === 'error_max_budget_usd'");
    expect(providerSrc).toContain("m.subtype === 'error_max_turns'");
  });

  it('logs per-result cost so the defaults can be tuned from evidence', () => {
    expect(providerSrc).toMatch(/total_cost_usd/);
    expect(providerSrc).toMatch(/usage: cost=/);
  });

  it('the host resolves guards before writing container.json', () => {
    // Resolution belongs on the host so the effective number is inspectable on
    // disk; the container must not have to recompute it.
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-config.ts'), 'utf-8');
    expect(src).toMatch(/maxBudgetUsd: resolveGuard\(row\.max_budget_usd, DEFAULT_MAX_BUDGET_USD\)/);
    expect(src).toMatch(/maxTurns: resolveGuard\(row\.max_turns, DEFAULT_MAX_TURNS\)/);
  });
});
