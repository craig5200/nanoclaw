/**
 * Webhook server route/handler split tests.
 *
 * The route key (URL segment, `/webhook/<routingPath>`) and the handler key
 * (`chat.webhooks[adapterName]`) are independent: a named adapter instance
 * registers its own Chat under its own URL while dispatching to the same
 * SDK adapter name. The 2-arg default keeps the historical single-instance
 * route byte-identical. Conventions follow PR #2617: real HTTP server on a
 * fixed WEBHOOK_PORT, real fetch.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { Chat } from 'chat';

import { registerWebhookAdapter, stopWebhookServer } from './webhook-server.js';

const PORT = 3917;
const BASE = `http://127.0.0.1:${PORT}`;

/** Minimal Chat stand-in: only `webhooks` is touched by the server. */
function stubChat(tag: string, adapterName = 'slack'): { chat: Chat; calls: string[] } {
  const calls: string[] = [];
  const chat = {
    webhooks: {
      [adapterName]: async (req: Request) => {
        calls.push(await req.text());
        return new Response(JSON.stringify({ via: tag }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  } as unknown as Chat;
  return { chat, calls };
}

async function post(path: string, body: string): Promise<Response> {
  // The server starts listening asynchronously after registration — retry
  // briefly on connection refusal instead of sleeping a fixed amount.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`${BASE}${path}`, { method: 'POST', body });
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

beforeEach(() => {
  process.env.WEBHOOK_PORT = String(PORT);
});

afterEach(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
  delete process.env.WEBHOOK_HOST;
});

describe('registerWebhookAdapter — route/handler split', () => {
  it('2-arg default: /webhook/<adapterName> dispatches to chat.webhooks[adapterName]', async () => {
    const { chat, calls } = stubChat('default');
    registerWebhookAdapter(chat, 'slack');

    const res = await post('/webhook/slack', 'payload-default');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: 'default' });
    expect(calls).toEqual(['payload-default']);
  });

  it('3-arg: routes by routingPath, dispatches by adapterName; the bare route stays unregistered', async () => {
    const { chat, calls } = stubChat('tester');
    registerWebhookAdapter(chat, 'slack', 'slack-tester');

    const res = await post('/webhook/slack-tester', 'payload-tester');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: 'tester' });
    expect(calls).toEqual(['payload-tester']);

    // Only the routed entry exists — /webhook/slack must 404, not leak into
    // the named instance's Chat.
    const miss = await post('/webhook/slack', 'stray');
    expect(miss.status).toBe(404);
    expect(calls).toEqual(['payload-tester']);
  });

  it('two same-adapterName registrations under distinct paths hit their own Chat instances', async () => {
    const worker = stubChat('worker');
    const tester = stubChat('tester');
    registerWebhookAdapter(worker.chat, 'slack');
    registerWebhookAdapter(tester.chat, 'slack', 'slack-tester');

    const r1 = await post('/webhook/slack', 'to-worker');
    const r2 = await post('/webhook/slack-tester', 'to-tester');
    expect(await r1.json()).toEqual({ via: 'worker' });
    expect(await r2.json()).toEqual({ via: 'tester' });
    expect(worker.calls).toEqual(['to-worker']);
    expect(tester.calls).toEqual(['to-tester']);
  });

  it('unregistered path 404s', async () => {
    const { chat } = stubChat('only');
    registerWebhookAdapter(chat, 'slack');
    const res = await post('/webhook/nope', 'x');
    expect(res.status).toBe(404);
  });
});

describe('bind address (fork change)', () => {
  // Upstream binds 0.0.0.0 unconditionally, publishing the port on every
  // interface the moment any non-gateway adapter registers — including
  // polling adapters like Telegram, which register here but never receive a
  // webhook. This install must not expose a public port, so the default is
  // loopback and WEBHOOK_HOST is the opt-in escape hatch.

  it('honors WEBHOOK_HOST: binds only the requested address', async () => {
    // 127.0.0.2 is a distinct loopback alias, so this proves the address is
    // really applied rather than being reachable via the catch-all bind.
    process.env.WEBHOOK_HOST = '127.0.0.2';
    const { chat } = stubChat('bound');
    registerWebhookAdapter(chat, 'slack');

    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`http://127.0.0.2:${PORT}/webhook/slack`, { method: 'POST', body: 'x' });
        break;
      } catch (err) {
        if (attempt >= 20) throw err;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    expect(await res.json()).toEqual({ via: 'bound' });

    // Same port on a different loopback address must be refused.
    await expect(
      fetch(`http://127.0.0.1:${PORT}/webhook/slack`, { method: 'POST', body: 'x' }),
    ).rejects.toThrow();
  });

  it('defaults to loopback, never 0.0.0.0', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'webhook-server.ts'), 'utf-8');
    expect(src).toContain("const DEFAULT_HOST = '127.0.0.1'");
    expect(src).toMatch(/const host = process\.env\.WEBHOOK_HOST \|\| DEFAULT_HOST/);
    expect(src).toMatch(/server\.listen\(port, host,/);
    // The unconditional public bind must not come back.
    expect(src).not.toMatch(/server\.listen\([^)]*'0\.0\.0\.0'/);
  });
});
