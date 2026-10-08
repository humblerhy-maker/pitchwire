# Architecture

```
provider poll
    → stamp Date.now + performance.now() when the body arrives
    → parse
    → adapter → ProviderSnapshot
    → EventEngine (dedupe, order, conflict, in-memory match state)
    → listeners (WebSocket, SSE, replay)
    → async journal insert (does not block publish)
```

The engine does not import a database. `src/server/runtime.server.ts` queues rows and flushes them once a second.

## Why this process is Node

Go is not installed. `apt` cannot install it here. `rustc` 1.98 is installed, but the product has to run as the single Node server on port 8080 that the preview and the Vercel build already use. A second process would be another hop, and it would not stay up on the serverless deploy. The measured bottleneck is the provider refresh (10–15 seconds, or "unknown" for ESPN), not language runtime. Processing of a normalized snapshot is sub-millisecond at 1,000 matches and still single-digit milliseconds at the p99 of a 5,000-match synthetic run. See [BENCHMARK.md](BENCHMARK.md).

## Providers

`LiveSportsProvider` in `src/providers/types.ts`.

| id | Module | Enabled when |
| --- | --- | --- |
| espn | `src/providers/espn.ts` | `ESPN_ENABLED` is not `0` |
| openligadb | `src/providers/openligadb.ts` | `OPENLIGADB_ENABLED` is not `0` |
| api-football | `src/providers/apifootball.ts` | `APIFOOTBALL_KEY` or `SPORTS_PROVIDER_API_KEY` or a key posted to `/credentials` |
| sportmonks | `src/providers/sportmonks.ts` | `SPORTMONKS_TOKEN` or a token posted to `/credentials` |
| demo | `src/providers/demo.ts` | mode is `demo` only |

Live mode drops `provider === "demo"`. Demo mode drops every other provider. Switching mode resets in-memory state so the two never share a match list.

Keys posted from the console stay in process memory. They are not written to the database and not returned by GET.

## Events

Normalized types include `GOAL`, `SCORE_CHANGED`, cards, `PENALTY`, `SUBSTITUTION`, period and match boundaries, plus `PROVISIONAL_GOAL`, `CONFIRMED_GOAL`, `CANCELLED_GOAL`.

If a provider does not say an event is confirmed, `certainty` stays `unspecified`. It is not upgraded. API-Football `Var` / `Goal cancelled` and Sportmonks VAR subtype 1512 become `CANCELLED_GOAL` with `certainty: "cancelled"`.

## Dedup, order, conflict

- Provider event id fingerprint suppresses repeats from the same provider.
- The same scoreline goal from a second provider is an observation on the first event, not a second client signal. Both receive times are kept.
- A lower `sequence` does not overwrite that provider's score.
- If two providers disagree on the score, the match is marked conflict and both views stay visible.

## Delivery

- `GET /ws/live` WebSocket on the dev server.
- `GET /sse/live` Server-Sent Events.
- REST: `/health`, `/ready`, `/matches`, `/matches/:id`, `/matches/:id/events`, `/providers`, `/providers/:id`, `/providers/:id/health`, `/metrics`, `/latency`, `/conflicts`, `/journal`, `/board`.
- `POST /mode`, `POST /replay`, `POST /credentials`.

The browser uses WebSocket, then SSE, then a 2s poll of `/board`.

## Replay

`POST /replay` with `{ "provider": "espn", "sample": true }` runs the captured 2026-10-06 scoreboard fragment through a new `EventEngine` with `replay: true`. Live state is not modified. The UI lists those events separately.

## Health

Each provider is `DISCONNECTED`, `RECONNECTING`, `DEGRADED` (3+ failures), or `HEALTHY`. Failures wait `backoffMs` (500ms exponential, jitter, cap 60s) instead of the normal poll interval.

## Database

`migrations/0002_pitchwire.sql`. PGLite when `DATABASE_URL` is unset, Postgres when it is set. Tables: providers, teams, matches, provider_events, events, observations, latency, provider_health, match_snapshots. The hot path only enqueues. The flush is the writer.

## What was not added

NATS, Redis, and ClickHouse. They do not change a 10-second provider cycle, and they are extra processes this host does not need for the current volume.
