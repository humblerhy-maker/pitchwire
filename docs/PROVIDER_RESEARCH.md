# Provider research

Checked on 2026-10-06 from this environment. If a fact was not read from the provider or from a response this environment actually received, it is marked UNKNOWN — REQUIRES VERIFICATION.

Nothing here is a promise that a feed is faster than a bookmaker. The measurable question is only: provider stamp (when one exists) → our receipt → our processing → our delivery.

## What was selected for the first running version

| Role | Provider | Why |
| --- | --- | --- |
| Default, no key, broad live list | ESPN site scoreboard | HTTP 200 on 2026-10-06. One URL returned in-play matches and goal rows. No key. |
| Default, official, no key | OpenLigaDB | Documented free API, no key, ODbL, 60 req/min/IP. Not low latency. |
| Ready when a key is set | API-Football | Official REST, documented 15s fixture refresh, free tier too small for that poll. |
| Ready when a token is set | Sportmonks | Official REST, documented 10s `/latest` cycle, free plan is two leagues, no websocket. |

ESPN is unofficial. It is enabled because it is the only source that actually had in-play football when this was built, and it needs no key. It is not a license.

## ESPN site scoreboard (unofficial)

| | |
| --- | --- |
| URL | `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard` |
| Documentation | No official developer docs. Community notes: https://github.com/pseudo-r/Public-ESPN-API |
| Live football | YES on 2026-10-06. HTTP 200 in ~0.10s. In-play events included (example: Nigeria at Russia, id 401917360). |
| Goal events | YES in `competitions[].details` (`type.text` "Goal", `scoringPlay`, player `athletesInvolved[].displayName`). A separate summary URL returned `keyEvents` with `id` and `wallclock`. |
| Streaming / WebSocket / SSE / push | NOT FOUND. This integration polls. |
| Polling | YES. Adapter interval 8s. No published rate limit. UNKNOWN — REQUIRES VERIFICATION what ESPN will block. |
| Free / trial | No key. Not a published free tier. |
| Timestamps | Scoreboard goal rows captured here had clock text, not a wall clock. Summary `keyEvents[].wallclock` did (example `2026-10-06T16:14:38Z` on a goal). The adapter currently publishes from the scoreboard, so provider stamps are usually absent. |
| Auth | None observed. |
| Restrictions | UNKNOWN — REQUIRES VERIFICATION. The GitHub mirror says "public" means reachable, not permission to redistribute. |
| Latency | No SLA. |
| Suitability | Useful for discovery and score changes without a key. Not a push feed. Not licensed. |

Summary probe: `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=401917360` returned `keyEvents` including Kickoff and Goal. Source description on that payload was `SA.ENVOY`.

## OpenLigaDB

| | |
| --- | --- |
| URL | https://www.openligadb.de/ and https://api.openligadb.de/ |
| Documentation | https://api.openligadb.de/swagger/v1/swagger.json and https://github.com/OpenLigaDB/OpenLigaDB-Samples |
| Live football | The API can return current matchdays. On 2026-10-06 `getmatchdata/bl1` returned 9 future Bundesliga matches (kickoff 2026-10-09), not in-play goals. |
| Goal events | YES in the schema: `goals[]` with `goalID`, `scoreTeam1`, `scoreTeam2`, `matchMinute`, `goalGetterName`, `isPenalty`, `isOwnGoal`, `isOvertime`. No goal wall-clock field in the schema. |
| Streaming / WebSocket / SSE / push | NOT in the swagger that was read. |
| Polling | YES. Swagger text: "Es gilt ein Limit von 60 Anfragen pro Minute und IP." They recommend `getlastchangedate` before a full fetch. This adapter polls `getmatchdata/{league}` every 30s for `bl1`, `bl2`, `bl3`, `dfb`, `ucl`. |
| Free | YES. "Ohne Anmeldung, ohne API-Schlüssel, ohne Kontingent." License text: "Daten unter ODbL 1.0". |
| Coverage | Community leagues. `ucl` returned Champions League 2026/2027 (18 matches, next kickoff 2026-10-13) during this check. `getavailableleagues` returned 835 historical rows. |
| Latency | Not a low-latency feed. Updates depend on community editors. |
| Auth | None. |
| Price | 0. The project says the server costs about 50 EUR/month and is privately funded. |
| Suitability | Correct free official source. Wrong tool if the requirement is seconds-from-the-goal. |

## API-Football (API-Sports)

| | |
| --- | --- |
| URL | https://www.api-football.com/ |
| Pricing | https://www.api-football.com/pricing (read 2026-10-06) |
| Documentation | https://www.api-football.com/documentation-v3 (this environment got 403/503 on the HTML docs). A mirror of the doc text was read at https://github.com/softpython2884/SportSphere/blob/sport/footapidocs.md |
| Base URL | `https://v3.football.api-sports.io` — confirmed. `GET /status` without a key returned HTTP 403 and `errors.token`: "Missing application key, Check our documentation on how to add your API key in headers." |
| Auth header | The live CORS header `access-control-allow-headers` listed `x-rapidapi-key, x-apisports-key, x-rapidapi-host`. The adapter sends `x-apisports-key`. An invalid key returned HTTP 200 with `errors.token`. |
| Live football | Pricing page lists Livescore on the free plan. Doc mirror: `GET /fixtures?live=all`. |
| Goal events | Doc mirror events table: Goal (Normal Goal, Own Goal, Penalty, Missed Penalty), Card (Yellow Card, Red card), Subst, Var (Goal cancelled, Penalty confirmed). "You can also retrieve all the events of the fixtures in progress with to the endpoint fixtures?live=all". Nested JSON examples on that mirror were collapsed to `{}`, so the adapter parses `time.elapsed`, `team`, `player`, `type`, `detail` and ignores unknown rows. UNKNOWN — REQUIRES VERIFICATION against a successful keyed response. |
| Update frequency | Doc mirror, fixtures section, exact sentence: "Although the data is updated every 15 seconds, depending on the competition there may be a delay between reality and the availability of data in the API." Also: "Update Frequency : This endpoint is updated every 15 seconds." Recommended calls: 1 per minute while fixtures are in progress. |
| WebSocket / SSE / push | Not found in the pages retrieved. Treat as REST only. UNKNOWN — REQUIRES VERIFICATION if a paid stream exists that was not in these pages. |
| Free | Pricing page: Free $0, 100 requests/day, and the livescore/events/fixtures lines are marked included. "Free plans are limited in terms of available seasons." |
| Paid | Same page: Pro $19 / 7,500 requests/day, then Ultra $29 / 75,000, Mega $39 / 150,000, custom up to 1,500,000/day. |
| 15s polling vs free tier | 86,400/15 = 5,760 requests/day for one global poll. Free tier is 100/day. It cannot run all day at the documented refresh. The adapter polls every 15s only after a key is present and stops with the API error body when the quota fails. |
| Timestamps | Fixture `date` is a kickoff. Event objects in the doc table are minute-based (`elapsed`). A true event wall clock was NOT verified. |
| Registration | https://www.api-football.com/pricing (subscribe). Dashboard host returned 403 to a HEAD from here: https://dashboard.api-football.com/register — UNKNOWN — REQUIRES VERIFICATION that the path is still the signup form. |
| Suitability | Best official low-cost candidate once a paid daily quota can hold a 15s poll. Still not sub-second, and the provider itself says there may be extra delay. |

## Sportmonks Football API v3

| | |
| --- | --- |
| Docs | https://docs.sportmonks.com/v3/tutorials-and-guides/tutorials/livescores-and-fixtures/livescores |
| Rate limit | https://docs.sportmonks.com/v3/api/rate-limit |
| Events | https://docs.sportmonks.com/v3/definitions/types/events.md and https://docs.sportmonks.com/v3/tutorials-and-guides/tutorials/includes/events |
| Scores | https://docs.sportmonks.com/v3/tutorials-and-guides/tutorials/includes/scores |
| Live | YES on paid and free, with a league cap. Endpoints: `/inplay`, base livescores, `/latest` ("Fixtures updated in the last 10 seconds"). |
| Free plan | "If you're on the free plan, the inplay response will contain matches from the Danish Superliga and Scottish Premiership only." Rate-limit page: Free 3,000 API calls / entity / hour, no credit card, no expiry. |
| Events | Include `events`. Type ids read from their definition page: 14 goal, 15 own goal, 16 penalty, 17 missed penalty, 18 substitution, 19 yellow, 20 red, 21 yellow/red, 10 VAR. Goal disallowed documented as type 10 with sub type 1512. |
| WebSocket | Their livescore page: "The inplay endpoint is not a WebSocket — it does not push updates." Their blog (2026-06-10) says webhooks are not currently available and tells you to poll then push to your own clients. |
| Poll | "Do not poll faster than 10 seconds. The endpoint updates on a 10-second cycle." Adapter uses `/livescores/latest` at 10s. |
| Timestamps | `minute`, `extra_minute`, `sort_order`. A wall-clock event time was not in the fields extracted. `starting_at` is the fixture start. |
| Auth | `api_token` query parameter. Token UI: https://my.sportmonks.com/ (HTTP 302 from here). |
| Price after free | Not fully re-read as a table in this session. A 2026-08-26 third-party comparison said entry paid is €29/month. UNKNOWN — REQUIRES VERIFICATION on https://www.sportmonks.com/football-api/plans-pricing/ |
| Suitability | Good official event model and a 10s cycle. Free coverage is two leagues. Not a push feed. |

## football-data.org

| | |
| --- | --- |
| URL | https://www.football-data.org/ |
| Docs | https://docs.football-data.org/general/v4/index.html and https://www.football-data.org/documentation/quickstart |
| Policies | https://docs.football-data.org/general/v4/policies.html — free plan 10 requests/minute for registered clients. Unauthenticated: 100 requests / 24h and only area/competition lists. |
| Live | The pricing page fetched on 2026-10-06 did not list a livescores add-on. It did list Odds and Statistic at "€15,- /mo". Third-party writeups say free scores are delayed and livescores are a paid add-on. UNKNOWN — REQUIRES VERIFICATION on the current pricing page for the livescore price. Do not use the free tier as a live goal feed. |
| WebSocket | Not found. |
| Probe | `GET https://api.football-data.org/v4/competitions` without a token returned HTTP 200 and a competition list. |
| Registration | HEAD `https://www.football-data.org/client/register` returned 405 (the path exists; HEAD is not allowed). |
| Suitability | Fixtures and tables. Not the live goal path unless a livescore subscription is confirmed. |

## OpenFoot API

| | |
| --- | --- |
| URL | https://openfootapi.com/ |
| Docs | https://openfootapi.com/docs |
| Pricing | https://openfootapi.com/pricing |
| Free | Starter $0, 5,000 requests/month. Docs: fixtures, competitions, standings, search. Live events are NOT on Starter. |
| Demo key | `of_demo_openfootapi_docs`, 30 req/min, Starter endpoints only. `GET /v1/matches?status=live` with that key returned HTTP 200 and `data: []` on 2026-10-06. |
| SSE | `GET /v1/live/stream` is documented on the Developer plan. Their words: goal alerts "within about a minute". |
| Sources they name | OpenLigaDB + ESPN for live, among others. |
| Price | Developer $14/month for live events, lineups, xG, 250,000 requests. |
| Suitability | Not faster than polling ESPN/OpenLigaDB yourself. "About a minute" is slower than the requirement. Not integrated. |

## TheSportsDB

| | |
| --- | --- |
| URL | https://www.thesportsdb.com/ |
| Docs | https://www.thesportsdb.com/documentation |
| Free key | The documentation page says the current free API key is `123`. Livescores are premium. |
| V2 livescore | `GET /api/v2/json/livescore/soccer` with `X-API-KEY`. Pricing material describes 2-minute livescores on the paid plan. |
| Price | Single developer described as $9/month in a third-party plans file sourced from their pricing page. Confirm on https://www.thesportsdb.com/pricing |
| WebSocket | Not found. |
| Suitability | Too slow (minutes) for this requirement. Not integrated. |

## Not integrated, and why

| Provider | Reason |
| --- | --- |
| Sportradar / Stats Perform (Opta) | Enterprise sales products. Current latency SLA and price were not verified in this session. UNKNOWN — REQUIRES VERIFICATION. They are the usual place a venue-level push feed is sold. This build does not pretend the free feeds match that. |
| Betfair Exchange Stream | Market stream, not a football event feed. Not used. |
| ClickHouse, NATS, Redis | Not added. Event volume here is polling, not millions of messages a second. In-process state plus Postgres/PGLite is the store. |

## Latency honesty

| Feed | What the provider actually said | What that means |
| --- | --- | --- |
| API-Football fixtures | Updated every 15 seconds, plus possible extra delay | A goal can sit at the provider for up to that cycle, then our poll, then our process. |
| Sportmonks `/latest` | 10-second cycle. Do not poll faster. Not a websocket. | Same shape, 10s floor at their side. |
| OpenFoot SSE | "within about a minute" | Slower. |
| TheSportsDB paid livescore | Described as 2-minute livescores | Slower. |
| OpenLigaDB | Community edits. No event wall clock in the Goal schema. | Not a latency product. |
| ESPN scoreboard | No published interval | Unknown. Polling at 8s only bounds how often we look. The interval was not reduced. |

## Second pass, 2026-10-06 — earlier than a public scoreboard

Searched again for a push or scout feed that can be connected without inventing an API. Free and trial options were checked before any paid feed. Marketing latency was not treated as a measurement.

### Chosen candidate: Betfair Exchange Stream, provisional only

Official stream docs and ESASwaggerSchema: TLS socket `stream-api.betfair.com:443`, CRLF JSON, not a WebSocket. Client sends `{op:"authentication", appKey, session}` then `marketSubscription`. `MarketChangeMessage.pt` is their message clock. `MarketDefinition.suspendReason` is documented for soccer as Goal, Third Party Unavailable, Penalty, Red Card, Non In Play Market. A 2025-08-11 forum announcement also lists Scout Unavailable.

Official FAQ, updated 2026-07-29: football scores and incidents are not in the Exchange API. A Goal suspension is a market halt. It has no score and no scorer. It is stored as `PROVISIONAL_GOAL`.

Delayed app keys are officially 1–180 seconds behind. This process refuses any tier other than `live`. The public key table lists a £299 activation fee for a live key. Personal use only unless Betfair approves commercial use.

REST catalogue used for discovery: `POST https://api.betfair.com/betting/json-rpc`, method `SportsAPING/v1.0/listMarketCatalogue`, headers `X-Application` and `X-Authentication`, filter `eventTypeIds: ["1"]`, `marketTypeCodes: ["MATCH_ODDS"]`, `inPlayOnly: true`. Getting Started says event type 1 is football. The stream MarketFilter schema that was read does not include `inPlayOnly`, so the socket subscription is by market id after the catalogue returns.

No goal-detection SLA is published. Whether the halt comes from a scout or an official feed: UNKNOWN — REQUIRES VERIFICATION. It can arrive before a public scoreboard. That is not proven until a live key produces a suspension that later pairs with an ESPN goal. Until then the source race says not measured.

### Not connected: Sportradar / IMG Arena Live Actions

Docs read 2026-10-06: `wss://dde-streams.data.srarena.io/media/soccer/fixtures/{fixtureId}/actions`. Legacy `wss://dde-streams.data.imgarena.com/...` decommissions 30 Sept 2026. The client sends the token as the first JSON message. Heartbeats every 10 seconds. “A new update any time a key action is completed.” REST `/actions` is post-match only. No millisecond SLA. Price: UNKNOWN — REQUIRES VERIFICATION. Fixture list URL was not verified as self-serve. The adapter stays idle. No fixture UUID is invented.

### Looked at and not integrated

| Source | What was actually found | Why it is not the early feed |
| --- | --- | --- |
| API-Football | Fixtures text: every 15 seconds, plus possible extra delay. No websocket in the pages read. Free plan 100 requests/day. | Not earlier than an 8-second public poll by documentation. |
| Sportmonks | `/livescores/latest` is a 10-second cycle. Their livescores page says the in-play endpoint is not a websocket. A 2026-06-10 blog still says webhooks are not available. | Cycle, not a push. Not claimed earlier than ESPN. |
| OpenFoot | Developer SSE described as goal alerts within about a minute. | Slower. |
| TheSportsDB | Paid livescores described as about 2 minutes. | Slower. |
| football-data.org | Free plan is not a live goal feed. Livescore price: UNKNOWN — REQUIRES VERIFICATION. | Not used. |
| FotMob / Sofascore / Flashscore | No official API confirmed. Automated retrieval is not used. | Not scraped. |
| LSports | Sales-led. A public self-serve trial and a goal SLA were not verified. | Not connected. UNKNOWN — REQUIRES VERIFICATION. |
| Orbistats | Their site says sub-50ms websocket and a 1-hour free window after approval. | That figure is their transport claim, not a measured goal-versus-ESPN delta. Not connected. |
| OddsFlow | Their page says odds snapshots every 10–20 seconds. | Not a goal-event feed. |

No anonymous free source was verified as a push goal feed that beats a public scoreboard. Polling ESPN faster was not done.

