# Source race

Checked 2026-10-06. A number on this page is a receipt delta. It is not a promise that a provider is always earlier, and it is not a 30-second or 60-second claim.

## What is compared

ESPN’s public scoreboard is the baseline. Other providers run at the same time. Scores are not merged. A provider is not called fastest except on the events that were actually compared.

A row counts only when that provider had already seen the match. The first payload that creates the match is backfill. Backfill is not a latency measurement.

Same scoreline: two providers both reported a goal, penalty, or confirmed goal at the same score while both were watching. The delta is ESPN’s server-receive time minus the other provider’s server-receive time. Positive means the other receipt was earlier.

Betfair: `suspendReason` Goal on an in-play match-odds market has no score, so it is not given the same scoreline key. It is paired with a later ESPN goal on the same match only when the ESPN receipt is after the suspension and within 300 seconds. That window stops a minute-10 halt being credited for a minute-80 goal. It is not a latency figure. Outside the window the row is UNPAIRED. Inside the window with no ESPN goal yet, the verdict is BASELINE HAS NOT REPORTED.

Name join uses the existing match id (normalized home, away, kickoff hour). Betfair names split on ` v ` only. A mismatch does not create a false advantage.

## Timestamps

| Stamp | When it exists |
| --- | --- |
| Provider event timestamp | Only if that provider sent an event time. ESPN’s scoreboard goal rows do not. Betfair does not. Shown as unavailable. |
| Provider publication timestamp | Betfair message field `pt` only. That is their message clock, not the kick. |
| Server receive | After the response bytes or stream line arrived, before JSON parse for polls. |
| Server parse | After JSON.parse when that moment was recorded. |
| Server publish | When the in-memory event was published. The database write is later and is not on this path. |
| Client receive | When this browser applied our message. Not the goal. |

No stamp is copied from another column. Nothing subtracts an assumed 30 or 60 seconds.

## What is connected

| Provider | State |
| --- | --- |
| ESPN | Baseline. Poll about 8 seconds. No push. Left at 8 seconds on purpose. |
| OpenLigaDB | Reference. Poll about 30 seconds. Community edit speed. |
| Betfair | Disconnected until a live app key and session exist. Delayed keys are refused. |
| Sportradar Live Actions | Not connected. Token plus a real fixture id are both required. No fixture id is invented. |
| API-Football | Disconnected until a key. Documented 15-second refresh. Not treated as earlier than ESPN. |
| Sportmonks | Disconnected until a token. Documented 10-second cycle, not a websocket. |

Webhook and Telegram run only when `PITCHWIRE_WEBHOOK_URL` or both Telegram variables are set. They are not the measurement.
