# OneCLI + host operational notes (this install only)

Install slug `3282970f` · `/opt/nanoclaw` · host user `nanoclaw` (uid 999, gid 987)

This file records deviations from a stock NanoClaw install on this box and the
procedures that keep them intact. It is fork-local documentation, not upstream
material — do not include it in a PR to `nanocoai/nanoclaw`.

---

## 1. NEVER re-run the OneCLI installer

```
# DO NOT RUN THIS:
curl -fsSL onecli.sh/install | sh
```

The installer re-downloads `docker-compose.yml` from the `main` branch of
`onecli/onecli` (unpinned — only the *image tag* is pinned, never the compose
file) and writes it over `~nanoclaw/.onecli/docker-compose.yml`. That **destroys
the local edit described in §2** and rebinds the listeners.

Setup's `onecli` step re-runs the installer if you answer **"Install a fresh
instance"** at its prompt. Always answer **"Use the existing instance"**.

To change the running stack, edit `~nanoclaw/.onecli/docker-compose.yml`
directly and:

```bash
cd /home/nanoclaw/.onecli && sudo -u nanoclaw env HOME=/home/nanoclaw \
  docker compose -p onecli up -d
```

## 2. Postgres is deliberately NOT published

Upstream's compose publishes Postgres on `${ONECLI_BIND_HOST}:${POSTGRES_PORT}`
with default credentials `onecli` / `onecli`. On bare-metal Linux the installer
resolves `ONECLI_BIND_HOST` to the **docker0 bridge IP** (`172.17.0.1` here), so
the stock configuration puts the vault database — which holds the Anthropic API
key — on an address reachable from **every container on the default bridge**,
including NanoClaw's own agent containers. That is precisely the party the vault
exists to keep the key away from.

The `ports:` block was removed from the `postgres` service. The app still
reaches it in-network at `postgres:5432`. The publication was admin convenience
only.

`POSTGRES_PASSWORD` was also replaced with a generated 40-char value in
`~nanoclaw/.onecli/.env` (mode 0600), replacing the `onecli` default.

**Verify it is still unpublished:**
```bash
docker inspect onecli-postgres-1 --format '{{.NetworkSettings.Ports}}'   # want: map[5432/tcp:[]]
```

## 3. OneCLI defaults to its CLOUD unless told otherwise — in two places

Both were found pointing at `api.onecli.sh` on this box and both are now pinned.
Re-check them after any OneCLI upgrade or when a new OS user runs `onecli`.

**(a) The CLI.** A fresh `onecli` config defaults `api-host` to
`https://api.onecli.sh`. Running `onecli secrets create` in that state uploads
the secret to a third party.
```bash
sudo -u nanoclaw env HOME=/home/nanoclaw onecli config get api-host
# want: http://172.17.0.1:10254
```

**(b) The SDK.** With `ONECLI_URL` unset in `.env`, `@onecli-sh/sdk` falls back
to the same cloud default. Observed directly: the host process held an
established TLS connection to `13.33.109.69:443`, which `dig` confirms is
`api.onecli.sh`. It was long-polling the cloud for approvals, and
`ensureAgent` / `applyContainerConfig` would have gone there too.
`ONECLI_URL=http://172.17.0.1:10254` in `/opt/nanoclaw/.env` is what prevents it.
```bash
PID=$(systemctl show -p MainPID --value nanoclaw-v2-3282970f.service)
ss -tnp | grep "pid=$PID"      # want: 172.17.0.1:10255, never 13.33.109.x
```

## 4. Local mode requires NEXTAUTH_SECRET to stay UNSET

Counter-intuitive: setting `NEXTAUTH_SECRET` switches the dashboard to OAuth
mode and requires `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`. Without those the
whole UI 307-redirects to `/setup-error?code=oauth-misconfigured` and no API key
can be issued, which blocks `onecli auth login` and therefore blocks storing any
secret. Leaving it unset gives single-user local mode, auto-authenticated as
`admin@localhost`. **Do not "harden" this by setting it.**

## 5. Rebuilding the agent image WILL OOM this box

The build (chromium + pnpm globals) caused a **global OOM** on 2026-07-25 at
21:50, killing a user-session `systemd`, `dbus-daemon`, and the **`litellm`
production container process** (auto-restarted in ~3s by `unless-stopped`).
The four IN services on 8420–8425 survived with unchanged PIDs, but this is not
guaranteed on a repeat. Swap was already ~84% consumed before the build started.

**Before any rebuild** (`/update-nanoclaw` bumping the image, `INSTALL_CJK_FONTS`,
`ncl groups config add-package`, or `container/build.sh`), pick one:

*Option A — free memory first (simplest):*
```bash
docker stop botv2-litellm
bash container/build.sh
docker start botv2-litellm
```

*Option B — build off-box (safest; no production impact):*
```bash
# on a bigger machine, same repo checkout:
bash container/build.sh
docker save nanoclaw-agent-v2-3282970f:latest | gzip > agent.tgz
# then here:
gunzip -c agent.tgz | docker load
```

`nice`/`ionice` do **not** help — the build executes inside dockerd's cgroup and
does not inherit the client's priority. Renicing dockerd penalizes every
production container equally and must not be used.

**Watch during a rebuild** (litellm is on internal 4000/tcp, so port-based health
checks on 8420–8425 will *not* catch its death):
```bash
watch -n5 'free -m | head -3; docker ps --format "{{.Names}} {{.Status}}"'
dmesg -T | grep -i "out of memory"
```

## 6. Pins and versions

| Component | Pin | Where |
|---|---|---|
| OneCLI gateway image | `1.36.0` | `versions.json`, `~nanoclaw/.onecli/.env` |
| OneCLI CLI binary | `2.2.5` | `versions.json`, `/usr/local/bin/onecli` |
| Postgres | `postgres:18-alpine` | compose (unpinned upstream) |
| Node (host) | v20 (`engines: >=20`; `.nvmrc` says 22) | system |

The compose file is **not** version-pinned upstream — it always comes from
`main`. Treat `~nanoclaw/.onecli/docker-compose.yml` as a local artifact.

## 7. Never `git pull`

Per `CLAUDE.md`, use `/update-nanoclaw` only. The startup tripwire
(`enforceUpgradeTripwire`) refuses to boot without a matching marker in
`data/upgrade-state.json`. That marker is normally stamped by `setup/service.ts`,
which this install **skips** (the systemd unit is hand-written — see §8), so after
any sanctioned upgrade re-stamp it:
```bash
sudo -u nanoclaw env HOME=/home/nanoclaw pnpm exec tsx scripts/upgrade-state.ts set
```

## 8. The systemd unit is hand-written

`/etc/systemd/system/nanoclaw-v2-3282970f.service` is **not** generated by
`setup/service.ts` (that step is skipped via `NANOCLAW_SKIP`). Re-running setup
without `service` in the skip list would overwrite it with a unit that has no
`User=`, no `MemoryMax=`, no `MemorySwapMax=`, and no `WEBHOOK_PORT`.

Always run setup as:
```bash
cd /opt/nanoclaw && sudo -u nanoclaw env HOME=/home/nanoclaw \
  PATH=/usr/local/bin:/usr/bin:/bin \
  NANOCLAW_SKIP=container,channel,service \
  pnpm run setup:auto
```

`WEBHOOK_PORT=18420` lives in the unit's `Environment=` because
`src/webhook-server.ts` reads `process.env` directly and `src/config.ts` does
**not** parse it from `.env`. Setting it in `.env` alone is a no-op. Default 3000
would collide with the existing `next-server`.

## 9. The webhook server binds loopback (fork change)

Upstream binds `0.0.0.0` unconditionally. `chat-sdk-bridge.ts` decides whether
to register a webhook based on the adapter exposing `startGatewayListener` —
**not** on whether it needs inbound HTTP. Telegram runs `mode: 'polling'` and has
no gateway listener, so it takes the non-gateway branch and calls
`registerWebhookAdapter` → `ensureServer()`. Installing Telegram therefore opened
a public port serving a route Telegram never calls.

Commit `640f56da` defaults the bind to `127.0.0.1` and adds `WEBHOOK_HOST` as the
opt-in override. Only set `WEBHOOK_HOST=0.0.0.0` for a genuinely webhook-driven
channel, and put a reverse proxy in front of it.

**Verify nothing is publicly bound after any channel install:**
```bash
ss -tlnp | grep -E ':18420|0\.0\.0\.0:18420'   # want: loopback only, or nothing
```
