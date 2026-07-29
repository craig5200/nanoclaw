import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ClaudeProvider } from './claude.js';
import { formatLocalStamp, TIMEZONE } from '../timezone.js';

// maybeRotateContinuation guards the cold-resume failure mode: a long-lived
// session whose on-disk transcript has grown so large (or old) that the SDK
// can't reload it before the host's idle ceiling kills the container.

let tmp: string;
let prevHome: string | undefined;
let prevConv: string | undefined;
let prevBytes: string | undefined;
let prevDays: string | undefined;

const PROJECT_DIR = '-workspace-agent';
const CWD = '/workspace/agent';

function writeTranscript(sessionId: string, bytes: number, firstTs?: string, lastTs?: string): string {
  const dir = path.join(tmp, '.claude', 'projects', PROJECT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.jsonl`);
  const first =
    JSON.stringify({
      type: 'user',
      timestamp: firstTs ?? new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    }) + '\n';
  const last = lastTs
    ? '\n' +
      JSON.stringify({
        type: 'user',
        timestamp: lastTs,
        message: { role: 'user', content: 'goodbye' },
      })
    : '';
  const filler = 'x'.repeat(Math.max(0, bytes - first.length - last.length));
  fs.writeFileSync(p, first + filler + last);
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rotate-'));
  prevHome = process.env.HOME;
  prevConv = process.env.NANOCLAW_CONVERSATIONS_DIR;
  prevBytes = process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES;
  prevDays = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  process.env.HOME = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(tmp, 'conversations');
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore('HOME', prevHome);
  restore('NANOCLAW_CONVERSATIONS_DIR', prevConv);
  restore('CLAUDE_TRANSCRIPT_ROTATE_BYTES', prevBytes);
  restore('CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS', prevDays);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ClaudeProvider.maybeRotateContinuation', () => {
  it('keeps a small, recent transcript (returns null, leaves file in place)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    const p = writeTranscript('sess-small', 4096);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-small', CWD)).toBeNull();
    expect(fs.existsSync(p)).toBe(true);
  });

  it('rotates an oversized transcript (returns reason, moves the .jsonl aside)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(64 * 1024);
    const p = writeTranscript('sess-big', 200 * 1024);
    const provider = new ClaudeProvider();
    const reason = provider.maybeRotateContinuation('sess-big', CWD);
    expect(reason).toContain('MB');
    expect(fs.existsSync(p)).toBe(false); // original moved out of the resume path
    const dir = path.dirname(p);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('sess-big.jsonl.rotated-'))).toBe(true);
  });

  it('rotates an aged transcript even when small', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS = '7';
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    writeTranscript('sess-old', 2048, old);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-old', CWD)).toContain('d');
  });

  it('returns null for an unknown session id', () => {
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('does-not-exist', CWD)).toBeNull();
  });
});

// Archive filenames identify the conversation, not the moment of archiving.
// Wall-clock naming filed a rotation archive under the rotation date — days
// after the conversation it contained — where the agent, navigating by date
// prefix, never found it.
describe('transcript archive naming', () => {
  const CONV = () => process.env.NANOCLAW_CONVERSATIONS_DIR!;

  function writeSessionsIndex(sessionId: string, summary: string): void {
    const dir = path.join(tmp, '.claude', 'projects', PROJECT_DIR);
    fs.writeFileSync(path.join(dir, 'sessions-index.json'), JSON.stringify({ entries: [{ sessionId, summary }] }));
  }

  function rotateAged(sessionId: string, firstTs: string): void {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS = '7';
    writeTranscript(sessionId, 2048, firstTs);
    expect(new ClaudeProvider().maybeRotateContinuation(sessionId, CWD)).not.toBeNull();
  }

  it('dates the archive by the transcript start, not the archive time', () => {
    const startedMs = Date.now() - 10 * 86400_000;
    rotateAged('sess-dated', new Date(startedMs).toISOString());

    const expected = formatLocalStamp(new Date(startedMs), TIMEZONE).slice(0, 10);
    const today = formatLocalStamp(new Date(), TIMEZONE).slice(0, 10);
    const files = fs.readdirSync(CONV());
    expect(files).toHaveLength(1);
    expect(files[0]).toStartWith(`${expected}-sessdate`); // start date + short session id
    expect(files[0]).not.toStartWith(today);
    expect(fs.readFileSync(path.join(CONV(), files[0]), 'utf-8')).toContain(`Covers: ${expected}`);
  });

  it('states the covered span so a session straddling midnight is still findable', () => {
    // The real failure case: started late on one day, ran into the next. The
    // filename can only carry the start date, so the header carries both ends.
    const startedMs = Date.now() - 10 * 86400_000;
    const endedMs = startedMs + 15 * 3600_000;
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS = '7';
    writeTranscript('sess-span', 2048, new Date(startedMs).toISOString(), new Date(endedMs).toISOString());
    expect(new ClaudeProvider().maybeRotateContinuation('sess-span', CWD)).not.toBeNull();

    const files = fs.readdirSync(CONV());
    const body = fs.readFileSync(path.join(CONV(), files[0]), 'utf-8');
    const from = formatLocalStamp(new Date(startedMs), TIMEZONE);
    const to = formatLocalStamp(new Date(endedMs), TIMEZONE);
    expect(body).toContain(`Covers: ${from} — ${to}`);
    expect(body).toContain('goodbye'); // the tail is in the dump, not just the header
  });

  it('supersedes an earlier archive of the same session when the summary slug changes', () => {
    const firstTs = new Date(Date.now() - 10 * 86400_000).toISOString();
    rotateAged('sess-super', firstTs);
    const before = fs.readdirSync(CONV());
    expect(before).toHaveLength(1);

    // Same session archived again, now with an SDK summary — one file, not two.
    writeSessionsIndex('sess-super', 'Weekly report draft');
    rotateAged('sess-super', firstTs);

    const after = fs.readdirSync(CONV());
    expect(after).toHaveLength(1);
    expect(after[0]).toEndWith('-weekly-report-draft.md');
    expect(after).not.toContain(before[0]);
  });

  it('keeps archives of different sessions from the same day separate', () => {
    const firstTs = new Date(Date.now() - 10 * 86400_000).toISOString();
    rotateAged('sess-aaaaaaa1', firstTs);
    rotateAged('sess-bbbbbbb2', firstTs);
    expect(fs.readdirSync(CONV())).toHaveLength(2);
  });
});
