# Pitchwire finder

Checked 2026-10-07, Africa/Lagos, against the public ESPN slate and Grok `grok-4.5`. No prices were invented. 1xBet was not scraped.

## What a request does

Finder reads the local calendar day (Africa/Lagos, UTC+1), not the UTC date. It loads the aggregated soccer scoreboard for the UTC dates that overlap that day, then every known soccer league scoreboard (219 leagues). NBA, MLB, and NHL dated boards are included, and the current undated board is merged so a price is not dropped only because one board omitted it. The same event is kept once. OpenLigaDB's by-date feed was empty for these dates and is not used as a second slate.

Finished matches are counted as discovered and are not selected. "Sure" means the strongest recent-score evidence, not a certainty. A short price is a penalty. A missing 1xBet price is left missing.

Over/Under with no sport is football. "N odds" is a combined decimal target, not a goal line.

## What the five requests actually returned

Today's local day still had only 6 football matches not yet started, out of 59 football events inside the day. The league sweep added 0 events beyond the aggregate. That limit is stated on the result.

- "I need 5 sure over 1.5 games" — football, Over 1.5, today. 219 leagues, 449 scoreboards, 213 events discovered, 59 inside the day, 127 outside, 6 summaries, 6 screened, 5 cleared the bar, 5 sent for review. Grok returned 5 ids. No public Over 1.5 price was on those boards.
- "I need 3 strongest football games today" — 3 different matches, Over 1.5, because that was the market with both clubs' recent scores. Not both sides of one game.
- "I need strongest football and basketball markets today" — 4 basketball events were inside the Lagos day and 5 were outside it. The basketball boards had 0 prices, so no basketball selection was issued. 3 football Overs were returned.
- "I need 10 over 1.5 games today" — same slate. 5 cleared. The other 5 were not invented.
- "I need 3 over 1.5 games tomorrow" — 74 pre-match football events inside the next Lagos day, 74 summaries, 74 screened, 66 cleared, 15 sent for review. Grok ranked 3. 195 events discovered. 91 were outside that day.

## Models

Grok uses the app reasoning key. Gemini, Groq, and Cohere stay disconnected until a key is stored in server memory. Keys are not written to the database and are not sent to the browser. If the model returns nothing, a selection is still returned only when the recent-score bar is met, and it is labeled as not model-confirmed. If no model is configured, nothing is issued.
