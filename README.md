# Pitchwire

Football event engine that compares sources. Live mode uses real provider payloads only. An earlier time is shown only when two providers report the same event while both were already watching. Internal processing time is not detection latency.

## Sports intelligence

Finder and Verification sit on the same live feeds. A card is issued only when the price and the evidence are both present. DraftKings prices from ESPN are not labeled 1xBet. 1xBet itself has no public API; The Odds API key `onexbet` is the supported path and stays off until `ODDS_API_KEY` is set. Gemini and Groq stay off until keys are stored in the settings screen. Details: [docs/INTELLIGENCE.md](docs/INTELLIGENCE.md).

## What is running by default

1. **ESPN scoreboard** (unofficial, no key) is the baseline public feed. One live request on 2026-10-06 returned in-play matches and goal rows. It is polled about every 8 seconds. It does not push. The interval was not shortened.
2. **OpenLigaDB** (official, free, no key, ODbL) is a reference. Editors type the goals. Polled about every 30 seconds.
3. **Betfair** Exchange Stream can push `suspendReason=Goal` on an in-play match-odds market. That is a provisional market halt, not a confirmed goal, and it has no score. It stays disconnected until a live app key and session exist. Delayed keys are refused because Betfair says they are 1–180 seconds behind.
4. **Sportradar Live Actions** is a real per-fixture websocket and is not connected. A token is not enough, and no fixture id is invented.
5. **API-Football** and **Sportmonks** stay disconnected until a key exists. Their documented cycles are 15 seconds and 10 seconds. Neither is treated as an earlier source.

No free push feed was verified as earlier than a public scoreboard. Details: [docs/PROVIDER_RESEARCH.md](docs/PROVIDER_RESEARCH.md) and [docs/SOURCE_RACE.md](docs/SOURCE_RACE.md).

## Keys

| Provider | Free? | Where |
| --- | --- | --- |
| ESPN | No signup. Unofficial. | Already on. Baseline. |
| OpenLigaDB | Free, no key. ODbL. | https://www.openligadb.de/ |
| Betfair | Live app key is paid. Their public key page lists a £299 activation fee. Personal use unless they approve commercial use. | Exchange Stream, not connected here without a live key. |
| Sportradar | No public self-serve price was verified. | Not connected. |
| API-Football | Free account, 100 requests/day. That cannot hold a 15s poll for a full day. Pro is $19/month for 7,500/day. | https://www.api-football.com/pricing |
| Sportmonks | Free plan, no card, Danish Superliga and Scottish Premiership only, 3,000 calls/entity/hour. | https://my.sportmonks.com/ |

Put keys in the environment or type them into the console. A key typed into the console stays in server memory for this process only. It is not stored in the database and not returned to the browser.

See [.env.example](.env.example).

## Modes

- **LIVE MODE** — ESPN and OpenLigaDB, plus any keyed provider that validated. No synthetic events. No fake fast mode.
- **DEMO MODE** — Harbour FC vs Northbridge, deterministic, fictional. Live providers are not polled. Switching mode wipes in-memory match state.

## Check that live data is arriving

- The match list shows **LIVE MODE**.
- Source race says **Not measured** until two watched sources report the same goal. That empty state is correct.
- A provider card says **HEALTHY** and a match count.
- `GET /health`, `GET /matches`, `GET /race`, `GET /providers/espn/health`.
- Processing numbers are internal only. If a histogram says no measurements yet, that is the truth.
- Replay runs a captured ESPN fragment from 2026-10-06 through a separate engine. Those rows are labelled replay and are not inserted into the live list.

## Layout

- `src/engine` — state, dedupe, conflicts, source race
- `src/providers` — adapters, including the idle Sportradar adapter and the Betfair suspension adapter
- `src/server` — poll supervisor, HTTP, websocket attach, async journal
- `src/routes` — UI and HTTP routes
- `migrations/0002_pitchwire.sql`
- `docs/PROVIDER_RESEARCH.md`, `docs/SOURCE_RACE.md`, `docs/ARCHITECTURE.md`, `docs/BENCHMARK.md`

Docker compose is in the repo (app, Prometheus, Grafana). It was not executed in this environment because Docker is not installed here.
