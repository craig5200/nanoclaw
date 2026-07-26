# Browsing: use the Golf PC relay for the consumer web

This VPS has a datacenter IP. Most consumer sites either block it or serve a
degraded page — one that looks fine but carries different prices, missing
inventory, or empty results. A plausible wrong answer is worse than a failure.

You have a browser relay running on a residential machine. **Prefer it for
shopping, prices, news, reviews, restaurants, tickets, travel, real estate,
social, forums, and anything paywalled or login-walled.** `WebFetch` is fine for
JSON APIs, docs, GitHub, and package registries.

Run `/golf-relay` for endpoints, the open-then-act session model, screenshot
retrieval, and etiquette. Two things to know without reading it:

- **Auth is automatic.** The OneCLI gateway injects the relay token at egress.
  Send no auth header, and never ask Craig for a token.
- **It's Craig's real desktop browser.** One page at a time, don't hammer, and
  ask before anything that submits, buys, posts, or books.
