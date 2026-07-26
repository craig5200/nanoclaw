---
name: golf-relay
description: >-
  Browse the consumer web through a real browser on a residential machine
  (the "Golf PC" relay). Use this for shopping, news, reviews, restaurants,
  ticketing, social, or any site that blocks or degrades datacenter traffic —
  which is most of the consumer web. Prefer this over WebFetch and
  agent-browser for those sites. Endpoints for opening pages, extracting text
  and headlines, screenshots, clicking, typing, and key presses.
compatibility: >-
  Requires the relay base URL in your standing instructions and a reachable
  relay host. Auth is injected by the OneCLI gateway — no token needed.
---

# Golf PC browser relay

A small FastAPI agent runs on a residential Windows machine (the "Golf PC")
driving a real browser. You POST JSON to it; it drives that browser and returns
results. Requests leave from a **residential IP in a real browser profile**,
which is why sites treat it like a person instead of a bot.

## Why prefer it

This VPS is a datacenter IP. Most of the consumer web treats datacenter traffic
as hostile: hard blocks, endless CAPTCHAs, or — worst of all — a *degraded* page
that looks fine but has different prices, no inventory, or no results. That last
failure mode is the dangerous one, because the answer looks plausible and is
wrong.

**Reach for the relay first for:** shopping and prices, product reviews, news
sites, restaurants and reservations, tickets and events, travel, real estate,
social media, forums, anything with a paywall or a login wall.

**Don't bother for:** API endpoints that return JSON, documentation sites,
GitHub, package registries, anything you'd hit programmatically. `WebFetch` is
faster and fine for those. If a plain fetch already gave you a clean answer,
don't re-fetch through the relay just because you can.

## Setup

Your **standing instructions** carry the relay's base URL — this skill
deliberately doesn't hardcode it. Set it once per shell session:

```bash
RELAY="<base URL from your standing instructions>"
```

**Authentication: there is nothing for you to do.** The relay is token-gated,
but the OneCLI gateway injects the `Authorization` header on the way out. Send
your requests with no auth header at all and they will be authenticated.

You will never see the token, you cannot read it, and you must **never ask the
user for it** or try to put one in a header yourself. If you find yourself
wanting a token, re-read this paragraph — the answer is that it's already
handled.

## Check it's alive first

```bash
curl -s -m 15 "$RELAY/health"
# {"status":"ok","agent":"craigbot-relay"}
```

`/health` is the one endpoint that needs no auth. If this fails, the Golf PC is
off, asleep, or off the tailnet — say so plainly rather than silently falling
back to `WebFetch` and handing over a datacenter-IP answer as if it were the
same thing.

## Session model — read this before chaining calls

**There is one browser and one current page.** `/open_url` navigates it;
`/extract_text`, `/extract_headlines`, `/screenshot`, `/click`, `/type_text`,
and `/press_key` all act on whatever page is currently open.

So the pattern is always **open, then act**:

```
/open_url  →  /extract_text | /extract_headlines | /screenshot | /click | ...
```

Never fire two `/open_url` calls concurrently — the second clobbers the first
and your extract lands on the wrong page. One page at a time, sequentially,
finish with it before you move on.

## Endpoints

All are `POST` with `Content-Type: application/json`, except `/health` (`GET`).
Shapes below are verified against the live relay.

### `POST /open_url` — navigate

```bash
curl -s -m 45 -X POST -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","wait_until":"domcontentloaded","timeout_ms":30000}' \
  "$RELAY/open_url"
# → {"url":"https://example.com/","title":"Example Domain","status":"success"}
```

| field | required | notes |
|---|---|---|
| `url` | yes | max ~2000 chars |
| `wait_until` | no | `load` \| `domcontentloaded` \| `networkidle` \| `commit` — default `domcontentloaded`. Use `networkidle` for JS-heavy pages that fill in late. |
| `timeout_ms` | no | 30000 is the working default |

Note the returned `url` may differ from what you asked for (redirects) and the
`title` tells you whether you got the page or an interstitial. Check both — a
title like "Access Denied" or "Just a moment..." means you got blocked, not
content.

### `POST /extract_text` — page text

```bash
curl -s -m 45 -X POST -H 'Content-Type: application/json' -d '{}' "$RELAY/extract_text"
# → {"url":"...","title":"...","text":"Example Domain\n\nThis domain is for use in..."}
```

Empty body `{}` — it operates on the current page. This is your default way to
read a page.

### `POST /extract_headlines` — headline list

```bash
curl -s -m 45 -X POST -H 'Content-Type: application/json' \
  -d '{"limit":10}' "$RELAY/extract_headlines"
# → {"url":"...","title":"...","headlines":["...","..."]}
```

`limit` is 1–20, default 10. Purpose-built for news front pages; cleaner than
extracting the whole page and guessing which lines are headlines.

### `POST /screenshot` — capture the page

Returns `{"image_base64": "<base64 PNG>"}`. Decode it straight into your
workspace so you can actually look at it:

```bash
mkdir -p /workspace/agent/screenshots
curl -s -m 60 -X POST -H 'Content-Type: application/json' \
  -d '{"full_page":false}' "$RELAY/screenshot" \
| node -e '
  let s="";
  process.stdin.on("data", d => s += d).on("end", () => {
    const b = JSON.parse(s).image_base64;
    if (!b) { console.error("no image_base64 in response"); process.exit(1); }
    const p = "/workspace/agent/screenshots/shot.png";
    require("fs").writeFileSync(p, Buffer.from(b, "base64"));
    console.log("wrote " + p);
  });'
```

Then **`Read` that path** — you can view PNGs directly, so read it rather than
describing it unseen. `/workspace/agent/` is writable and persists across
container restarts.

`full_page: true` captures the whole scrollable page; default `false` is the
viewport. Full-page shots of long pages get big — prefer viewport unless you
need the whole thing. Give files distinct names when taking several
(`drudge-top.png`, not `shot.png` four times).

There is no `jq` or `python3` in this container — use `node` (as above) or
`bun` for JSON.

### `POST /click` — click an element

```bash
curl -s -m 20 -X POST -H 'Content-Type: application/json' \
  -d '{"selector":"button.submit","timeout_ms":10000}' "$RELAY/click"
```

CSS selector. `timeout_ms` defaults to 10000. Screenshot first if you're
unsure what's on the page — clicking blind on a real browser someone else owns
is how you end up somewhere unintended.

### `POST /type_text` — type into a field

```bash
curl -s -m 30 -X POST -H 'Content-Type: application/json' \
  -d '{"selector":"input[name=q]","text":"wireless headphones","delay_ms":50,"timeout_ms":10000}' \
  "$RELAY/type_text"
```

`delay_ms` (default 50) is per-keystroke — it exists to look human. Don't set
it to 0.

### `POST /press_key` — press a key

```bash
curl -s -m 15 -X POST -H 'Content-Type: application/json' \
  -d '{"key":"Enter"}' "$RELAY/press_key"
```

Playwright key names: `Enter`, `Tab`, `Escape`, `ArrowDown`, `PageDown`. Only
`key` is sent — this endpoint takes no timeout.

## Etiquette

This is **Craig's actual desktop browser on his actual home connection**, not a
disposable scraper. Behave accordingly.

- **One page at a time.** Sequential calls, never concurrent.
- **Don't hammer.** A couple of seconds between navigations. No tight loops, no
  pagination sprints. If a task needs 30 page loads, stop and discuss the
  approach first.
- **Don't leave it somewhere odd.** When you're done with something sensitive,
  navigate somewhere neutral.
- **Read-only by default.** `/click`, `/type_text`, and `/press_key` change
  state on a real browser that may hold real logged-in sessions. Extracting and
  screenshotting are safe; interacting is not. Before anything that submits,
  purchases, posts, books, or sends — **ask first**.
- **Never enter credentials or payment details.** If a flow demands them, stop
  and hand it back to Craig.
- **Don't treat a block as content.** If the title or text says you were
  blocked, rate-limited, or CAPTCHA'd, report that. Don't paper over it with a
  `WebFetch` result and present it as equivalent.

## When it fails

| Symptom | Meaning | Do this |
|---|---|---|
| `/health` times out or connection refused | Golf PC off, asleep, or off the tailnet | Tell Craig it's unreachable. Don't silently downgrade to `WebFetch`. |
| `401 {"detail":"Unauthorized"}` | Gateway didn't inject the token — vault secret missing, renamed, or host-pattern no longer matches | Operator problem, not yours. Report it; do **not** ask for a token or try to supply one. |
| `200` but title is "Just a moment…" / "Access Denied" | The site blocked even the residential browser | Try `wait_until: networkidle`, or screenshot to see what's on screen. Some sites are simply closed to us — say so. |
| Empty or tiny `text` | Page renders late via JS | Re-open with `wait_until: networkidle`, then extract again. |
| Extract returns the wrong page | Something else navigated the browser | Re-`open_url` and redo. Check you aren't running calls concurrently. |
| Timeout on `/open_url` | Slow site or heavy page | Retry **once** with a longer `timeout_ms`. Don't retry-loop. |

## Reporting

Say where the answer came from. "Via the relay, the top headline is X" is more
useful than a bare claim, because it tells Craig which IP and which browser saw
it. If you fell back to `WebFetch`, say that too — the answers are not
interchangeable.
