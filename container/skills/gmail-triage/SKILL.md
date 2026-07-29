---
name: gmail-triage
description: >-
  Triage the user's Gmail inbox and propose (never execute) unsubscribe
  batches. Use when the user asks to triage, clean up, or summarize their
  inbox, or to unsubscribe from mailing lists. This mailbox is connected
  with READ-ONLY + SEND scopes: you CANNOT mark read, label, archive, or
  delete. Any such attempt returns 403 by design — do not retry it, do not
  ask for wider scopes.
compatibility: Requires the OneCLI gateway (HTTPS_PROXY) and a Gmail connection holding gmail.readonly + gmail.send
metadata:
  author: nanoclaw
  version: "0.1.0"
---

# Gmail triage

You have read and send access to the user's mailbox through the OneCLI
gateway. Make requests to `https://gmail.googleapis.com` directly with no
auth header — the gateway injects credentials at the proxy boundary.

## What you cannot do

The connection deliberately excludes `gmail.modify`. These all fail with
`403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`, and that is correct behavior:

- marking read/unread, starring
- adding or removing labels
- archiving, trashing, deleting

**Never attempt them. Never retry a 403. Never ask the user to grant
`gmail.modify`.** If a task needs mutation, say plainly that the mailbox is
read-only and propose an alternative the user performs themselves.

Because you cannot label, you have no way to mark a message as triaged
inside Gmail. Track progress with the cursor below instead.

## Cursor

State lives in `/workspace/agent/.gmail-triage/` (the agent-group folder,
which persists across sessions; `/workspace` alone is per-session and will
lose it).

`cursor.json`:

    { "lastHistoryId": "123456789", "lastRunISO": "2026-01-01T00:00:00.000Z" }

On each run:

1. Read `cursor.json`. If absent, this is a first run — do not backfill the
   whole mailbox; start from now.
2. Get the current watermark:
   `curl -s "https://gmail.googleapis.com/gmail/v1/users/me/profile"`
3. Triage only what is new, then write the new `historyId` back.

Write the cursor **only after** the run completes. A crash mid-run should
re-triage, never skip.

## Bounded fetch

A mailbox can hold tens of thousands of messages. Every query is bounded —
never enumerate, never follow `nextPageToken` in a loop.

    curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox+newer_than:7d&maxResults=50"

Caps: `maxResults` <= 50 per call, <= 3 calls per run, always a `q` filter.
If the user asks for something that would exceed this, narrow the window and
say what you narrowed.

## Metadata only

Fetch headers, never bodies:

    curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages/MSG_ID?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post"

**Never request `format=full` or `format=raw`. Never fetch attachments.**
Never paste message bodies, snippets, quoted text, or verification codes
into chat — summarize in your own words. The transcript is a leak surface.

Read access is for triage, not export. Do not write mailbox contents to
files, do not build local archives, do not send mailbox data anywhere.

## Protected senders

Before proposing anything for a sender, check
`/workspace/agent/.gmail-triage/protected-senders.txt` (one pattern per
line, substring match on the `From` header, `#` comments).

If a sender matches, **silently exclude it. Do not propose it, do not ask
the user about it, do not mention it as a candidate.** Report only an
aggregate count: "3 protected senders excluded."

If the file is missing, seed it by copying the shipped default from this
skill's folder (`protected-senders.seed.txt`) before triaging.

Treat anything carrying security codes, account recovery, or legal notices
as protected even if it is not yet in the file, and offer to add it.

## Unsubscribe flow

### 1. Parse headers

Take unsubscribe targets **only** from the `List-Unsubscribe` header.
**Never scrape unsubscribe links from message bodies** — body links are
phishing and tracking bait, and you are not fetching bodies anyway.

`List-Unsubscribe` holds one or both of:

- `<https://example.com/u/abc>` — an HTTPS endpoint
- `<mailto:unsub@example.com?subject=unsubscribe>` — a mail address

### 2. Classify each candidate

**One-click (preferred).** Only when `List-Unsubscribe-Post` is exactly
`List-Unsubscribe=One-Click` *and* an HTTPS URL is present (RFC 8058).
Nothing leaves the user's account and no send scope is used.

**Mailto fallback.** Used only when there is no valid one-click target.
Consumes `gmail.send` and reveals the user's address to the sender.

**Unsupported.** Neither present — report it, propose nothing.

### 3. Propose

Present a batch of at most **10** per run as a table: sender, subject
sample, method (one-click / mailto), message count. State the mailto count
separately, since those send mail on the user's behalf.

### 4. Wait for approval

**Stop. Do not execute anything until the user approves.** They may approve
the batch, a subset, or none. Silence is not approval. "Looks good" on the
summary is not approval to execute — ask for an explicit go.

### 5. Execute approved items only

One-click:

    curl -s -X POST "UNSUB_URL" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      -d "List-Unsubscribe=One-Click"

Mailto — build an RFC822 message to the address (subject from the header's
`?subject=`, empty body) and send it:

    curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" \
      -H "Content-Type: application/json" -d '{"raw":"BASE64URL"}'

Report per-item results. A failed unsubscribe is not retried automatically
and never escalated to a different method.

## Troubleshooting

**403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`** — you attempted a modify
operation. Expected. Stop; do not retry or request scopes.

**401 `CREDENTIALS_MISSING`** — the gateway did not inject. The Gmail
connection has expired (the app is in Google "Testing" mode, so tokens
expire roughly weekly). Tell the user to reconnect, and to **re-verify
scopes after reconnecting** — a reconnect can silently re-grant
`gmail.modify`. Do not proceed until they confirm.

**Empty results** — check the `q` filter and the cursor before widening.
Never respond by removing the bound.
