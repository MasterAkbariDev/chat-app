# Config Bot Plan — VPN Config Distribution (DEFERRED · OPTIONAL · LAST)

> **Not required for launch.** Build only after BACKEND B0–B12, FRONTEND F0–F12, FLUTTER A0–A12,
> and ADMIN D0–D5 have shipped and are stable. This document exists so the design is settled and
> `TODO(config-bot)` markers in the code have a reference.

## Goal (Q10)

Distribute working VPN configs (VLESS / VMess links, subscription blobs) to app users through a
dedicated in-app **Config** section, kept fresh automatically, resilient to DPI / DNS
interference.

## Why it's hard / why it's last

- Requires a **new service on a foreign (uncensored) server** — a crawler that harvests configs
  from public sources and writes them to a file / endpoint. That code does not exist yet.
- The **chat VPS (in a censored network)** must fetch that file **over a DNS-based tunnel**
  (DoH/DoT or a DNS-encapsulated transport) to bypass DPI/SNI filtering and DNS poisoning.
- It's an operational feature (rotating infra, keeping sources alive) with ongoing maintenance
  cost, unrelated to core chat.

## Architecture

```
[Foreign VPS: config-crawler]                         [Chat VPS: legacy-chat API]
  cron: crawl sources (telegram channels, public                fetcher worker (BullMQ, every N min):
        repos, subscription URLs) → parse VLESS/VMess    ───►     resolve crawler host via DoH (e.g. 1.1.1.1/dns-query
        → dedupe → health-check (tcp/tls probe)                    or a hardcoded IP) ; GET over HTTPS with a
        → sign + write configs.json (+ .sig)                       shared secret ; verify signature
  serve configs.json over HTTPS (static, or a tiny API)   ◄───     → upsert `vpn_configs` collection
                                                                   → mark stale ones inactive
                                                          Admin Panel (D6): curate / categorise / pin / expire
                                                          App/Web: GET /v1/configs (read-only) → Config section
```

### `config-crawler` (new repo `config-crawler`)
- Language: whatever's fastest to ship (Node/TS to share tooling, or Go for a single binary).
- Sources: a config-file list of URLs / channels. Pluggable parsers per source.
- Pipeline: fetch → parse links → normalise → **dedupe** (by host:port:uuid) → **liveness probe**
  (TCP connect + TLS handshake, optionally a real proxy handshake) → score → keep top N per
  region/protocol.
- Output: `configs.json` = `[{ id, protocol, name, region?, link, addedAt, lastCheckedAt, score }]`
  + an HMAC/ed25519 signature file. Served as a static file behind HTTPS + basic auth or a bearer.
- Rotates its own listening domain/IP; the chat VPS gets the current one via a small bootstrap
  (a DNS TXT record it reads over DoH, or a hardcoded fallback list).

### Chat VPS side (backend — a new `configs` module, feature-flagged `configBot`)
- **Fetcher worker** (BullMQ, interval): resolve the crawler host **over DoH** (bypasses local DNS
  poisoning); `GET` the signed `configs.json`; **verify the signature**; upsert into
  `vpn_configs {id, protocol, name, region?, link, category?, active, pinned, addedAt,
  lastCheckedAt, source, usageCount}`; deactivate configs missing from the latest fetch.
- Transport hardening: if plain DoH+HTTPS is blocked, fall back to a DNS-encapsulated fetch (chunk
  the file over TXT queries) or a domain-fronted request — implement one, design for swapping.
- `GET /v1/configs?category=&region=` — **read-only**, auth required, returns active + curated
  configs; `POST /v1/configs/:id/use` (usage stat).
- Admin API (`/v1/admin/configs`): source management, manual "fetch now", curate (rename,
  categorise, pin, hide, expire), fetch-health status.
- **No user writes.** The old insecure `POST /config-logs` stays removed.

### App / Web — Config section
- A dedicated area (a special "channel"-like view or a top-level "Config" entry):
  - list of configs grouped by category/region, with a freshness indicator ("updated 12m ago"),
  - per config: **copy link**, **QR code**, **"Import to <v2rayNG / Shadowrocket / Hiddify>"**
    deep link, protocol + name,
  - a "Refresh" pull (triggers a re-read, not a re-crawl),
  - search.
- Read-only; no compose.

## Phases (only start after M9)

| Phase | Work |
|---|---|
| **CB1** | `config-crawler` repo: sources config, parsers, dedupe, liveness probe, signed `configs.json`, HTTPS serve. Deploy on a foreign VPS. |
| **CB2** | Backend `configs` module: DoH resolver, signed fetch worker, `vpn_configs` schema, `GET /v1/configs`, feature flag. |
| **CB3** | Transport hardening: DNS-encapsulated / domain-fronted fallback fetch; host-rotation bootstrap (DoH TXT). |
| **CB4** | Admin D6: source management, curation, fetch-health, manual fetch, usage stats. |
| **CB5** | App A13 + Web F13: Config section UI (list, copy, QR, client deep links, freshness, search). |
| **CB6** | Ops: alerting on stale feed / dead sources / fetch failures; runbook for rotating the foreign host. |

## Risks

- Foreign host gets blocked → the rotation bootstrap + fallback transports are essential, not
  optional.
- Legal/policy exposure of hosting a config-distribution feature → confirm the owner accepts this
  (out of scope for engineering).
- Source quality decay → the liveness probe + scoring must be real, and the admin curation is the
  safety valve.
- Maintenance burden → keep the crawler small and the source list data-driven.

## Acceptance

- The foreign crawler produces a signed, deduped, health-checked config list.
- The chat VPS fetches it over an interference-resistant transport and verifies the signature.
- Users see a fresh, categorised, read-only Config section with copy / QR / import.
- Admins curate the feed and see its health.
- Everything is behind the `configBot` flag and can be turned off without affecting chat.
