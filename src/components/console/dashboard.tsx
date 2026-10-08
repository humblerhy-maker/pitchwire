import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Radio, TriangleAlert } from "lucide-react";
import type { PublicBoard, PublicEvent, PublicMatch, Quantiles } from "@/engine/model";

type Race = PublicBoard["races"][number];

type Wire =
  | { kind: "snapshot"; board?: PublicBoard }
  | { kind: "event"; event?: PublicEvent }
  | { kind: "match"; match?: PublicMatch }
  | { kind: "providers"; providers?: PublicBoard["providers"] };

const GOALISH = new Set(["GOAL", "PENALTY", "PROVISIONAL_GOAL", "CONFIRMED_GOAL", "CANCELLED_GOAL"]);

export function Dashboard({ initial }: { initial: PublicBoard }) {
  const [board, setBoard] = useState(initial);
  const [transport, setTransport] = useState("connecting");
  const [filter, setFilter] = useState<"live" | "all">("live");
  const [selectedId, setSelectedId] = useState<string | null>(initial.matches.find((m) => m.status === "IN_PLAY")?.matchId ?? null);
  const [flash, setFlash] = useState<PublicEvent | null>(null);
  const [replay, setReplay] = useState<PublicEvent[]>(initial.replay ?? []);
  const [keyProvider, setKeyProvider] = useState("api-football");
  const [keyValue, setKeyValue] = useState("");
  const [keySession, setKeySession] = useState("");
  const [keyTier, setKeyTier] = useState("live");
  const [keyNote, setKeyNote] = useState("");
  const [notifyOn, setNotifyOn] = useState(false);
  const [clientReceived, setClientReceived] = useState<Record<string, string>>({});

  function stampOne(id: string, now: string) {
    setClientReceived((prev) => (prev[id] ? prev : { ...prev, [id]: now }));
  }

  function stampClient(matches: PublicMatch[], now: string) {
    setClientReceived((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const match of matches) {
        for (const event of match.events) {
          if (!next[event.eventId]) {
            next[event.eventId] = now;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }

  useEffect(() => {
    const now = new Date().toISOString();
    const seeded: Record<string, string> = {};
    for (const match of initial.matches) {
      for (const event of match.events) seeded[event.eventId] = now;
    }
    setClientReceived(seeded);
  }, [initial]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let es: EventSource | null = null;
    let poll: number | null = null;
    let closed = false;

    const apply = (msg: Wire) => {
      const now = new Date().toISOString();
      if (msg.kind === "snapshot" && msg.board) stampClient(msg.board.matches, now);
      if (msg.kind === "event" && msg.event) stampOne(msg.event.eventId, now);
      if (msg.kind === "event" && msg.event?.replay) {
        setReplay((rows) => [msg.event!, ...rows].slice(0, 12));
        return;
      }
      if (
        msg.kind === "event" &&
        msg.event &&
        !msg.event.backfill &&
        GOALISH.has(msg.event.type)
      ) {
        setFlash(msg.event);
        if (notifyOn && typeof Notification !== "undefined" && Notification.permission === "granted") {
          const title = msg.event.type === "CANCELLED_GOAL" ? "Goal cancelled" : "Goal";
          new Notification(title, {
            body: `${msg.event.homeTeam} ${msg.event.scoreHome ?? "—"}-${msg.event.scoreAway ?? "—"} ${msg.event.awayTeam}`,
          });
        }
      }
      setBoard((current) => reduceBoard(current, msg));
    };

    const startPoll = () => {
      if (poll !== null) return;
      setTransport("poll");
      poll = window.setInterval(() => {
        void fetch("/board")
          .then((res) => (res.ok ? res.json() : null))
          .then((body) => {
          if (!body) return;
          const next = body as PublicBoard;
          stampClient(next.matches, new Date().toISOString());
          setBoard(next);
        })
          .catch(() => undefined);
      }, 2000);
    };

    const startSse = () => {
      es = new EventSource("/sse/live");
      es.onopen = () => setTransport("sse");
      es.onmessage = (ev) => {
        try {
          apply(JSON.parse(ev.data) as Wire);
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => {
        es?.close();
        if (!closed) startPoll();
      };
    };

    if (initial.websocket) {
      try {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/ws/live`);
        ws.onopen = () => setTransport("websocket");
        ws.onmessage = (ev) => {
          try {
            apply(JSON.parse(String(ev.data)) as Wire);
          } catch {
            /* ignore */
          }
        };
        ws.onerror = () => ws?.close();
        ws.onclose = () => {
          if (!closed) startSse();
        };
      } catch {
        startSse();
      }
    } else {
      startSse();
    }

    return () => {
      closed = true;
      ws?.close();
      es?.close();
      if (poll !== null) window.clearInterval(poll);
    };
  }, [notifyOn, initial.websocket]);

  const matches = useMemo(() => {
    const rows = board.matches.slice().sort(sortMatches);
    if (filter === "live") return rows.filter((m) => m.status === "IN_PLAY" || m.status === "HALFTIME");
    return rows;
  }, [board.matches, filter]);

  const selected = board.matches.find((m) => m.matchId === selectedId) ?? matches[0] ?? null;
  const liveCount = board.matches.filter((m) => m.status === "IN_PLAY" || m.status === "HALFTIME").length;

  async function switchMode(mode: "live" | "demo") {
    const res = await fetch("/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (res.ok) setBoard((await res.json()) as PublicBoard);
  }

  async function saveKey() {
    const res = await fetch("/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: keyProvider,
        key: keyValue,
        session: keyProvider === "betfair" ? keySession : undefined,
        tier: keyProvider === "betfair" ? keyTier : undefined,
      }),
    });
    const body = (await res.json()) as { detail?: string; error?: string };
    setKeyNote(body.detail || body.error || "");
    setKeyValue("");
  }

  async function runReplay() {
    const res = await fetch("/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "espn", sample: true }),
    });
    const body = (await res.json()) as { events?: PublicEvent[]; detail?: string };
    if (body.events) setReplay(body.events.filter((e) => e.type === "GOAL" || e.type === "PENALTY").slice(0, 12));
    setKeyNote(body.detail ?? "");
  }

  async function enableNotifications() {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifyOn(perm === "granted");
  }

  return (
    <main className="min-h-screen overflow-x-clip bg-bg text-fg">
      <header className="border-b border-line px-4 py-4 md:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-display text-4xl leading-none tracking-wide text-fg">PITCHWIRE</p>
            <p className="mt-1 text-sm text-muted">Which source reported the goal first. Internal processing time is not detection latency.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                board.mode === "live"
                  ? "bg-signal px-3 py-2 text-sm font-semibold text-signal-ink"
                  : "bg-surface-2 px-3 py-2 text-sm font-semibold text-fg"
              }
            >
              {board.mode === "live" ? "LIVE MODE" : "DEMO MODE"}
            </span>
            <span className="border border-line px-3 py-2 text-sm text-muted">{transport}</span>
            <button
              type="button"
              className="min-h-11 border border-line px-3 py-2 text-sm"
              onClick={() => void switchMode(board.mode === "live" ? "demo" : "live")}
            >
              {board.mode === "live" ? "Switch to demo" : "Switch to live"}
            </button>
          </div>
        </div>
      </header>

      {flash ? (
        <div className="flash-in border-b border-line bg-signal text-signal-ink">
          <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-3 px-4 py-4 md:px-8">
            <div>
              <p className="font-display text-5xl leading-none">{flash.type.replaceAll("_", " ")}</p>
              <p className="mt-1 font-display text-3xl leading-none">
                {flash.homeTeam} {flash.scoreHome ?? "—"} — {flash.scoreAway ?? "—"} {flash.awayTeam}
              </p>
              <p className="mt-2 text-sm">
                {flash.clock ?? "clock unknown"} · {flash.player ?? "scorer not in payload"} · {flash.provider}
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <dt>Received (UTC)</dt>
              <dd className="font-medium">{clock(flash.serverReceiveTimestamp)}</dd>
              <dt>Published (UTC)</dt>
              <dd className="font-medium">{clock(flash.publishedTimestamp)}</dd>
              <dt>Internal processing</dt>
              <dd className="font-medium">{flash.processingMs.toFixed(1)} ms</dd>
              <dt>Provider stamp → us</dt>
              <dd className="font-medium">{ms(flash.providerStampToReceiveMs)}</dd>
            </dl>
          </div>
        </div>
      ) : null}

      <SourceRacePanel races={board.races ?? []} clientReceived={clientReceived} />

      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 md:px-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.8fr)]">
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-display text-2xl tracking-wide">Matches</h2>
            <div className="flex gap-2">
              <FilterChip active={filter === "live"} onClick={() => setFilter("live")}>
                Live {liveCount}
              </FilterChip>
              <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
                All {board.matches.length}
              </FilterChip>
            </div>
          </div>
          {matches.length === 0 ? (
            <p className="border border-line bg-surface p-6 text-sm text-muted">
              {board.mode === "demo"
                ? "Demo script is starting. Harbour FC vs Northbridge is fictional and never mixed into live mode."
                : "No in-play matches in the latest provider payloads. This is not a simulated scoreline. Switch the filter to All to see scheduled fixtures the feeds actually returned."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {matches.map((match) => (
                <li key={match.matchId}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(match.matchId)}
                    className={
                      "w-full border px-4 py-3 text-left " +
                      (selected?.matchId === match.matchId ? "border-signal bg-surface" : "border-line bg-surface")
                    }
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs tracking-wide text-muted uppercase">
                          {match.competition ?? "Competition not supplied"} · {match.status.replaceAll("_", " ")}
                        </p>
                        <p className="mt-1 font-display text-2xl leading-none break-words sm:text-3xl">
                          {match.homeTeam}{" "}
                          <span className="text-signal">
                            {score(match.scoreHome)}–{score(match.scoreAway)}
                          </span>{" "}
                          {match.awayTeam}
                        </p>
                      </div>
                      <p className="font-display text-2xl leading-none text-signal sm:text-3xl">{match.clock ?? "—"}</p>
                    </div>
                    <p className="mt-2 text-sm text-muted">
                      {match.lastEvent
                        ? `${match.lastEvent.type} ${match.lastEvent.player ?? ""} ${match.lastEvent.clock ?? ""} · ${match.lastEvent.provider} · received ${clock(match.lastEvent.serverReceiveTimestamp)}`
                        : "No event yet"}
                      {match.conflict ? " · CONFLICT" : ""}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selected ? (
            <article className="mt-4 border border-line bg-surface p-4">
              <h3 className="font-display text-2xl">
                {selected.homeTeam} {score(selected.scoreHome)}–{score(selected.scoreAway)} {selected.awayTeam}
              </h3>
              {selected.conflict ? (
                <p className="mt-2 flex items-start gap-2 text-sm text-fg">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden="true" />
                  {selected.conflictDetail}
                </p>
              ) : null}
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {selected.providerViews.map((view) => (
                  <p key={view.provider} className="border border-line px-3 py-2 text-sm">
                    <span className="text-muted">{view.provider}</span> {score(view.scoreHome)}–{score(view.scoreAway)}{" "}
                    {view.clock ?? view.status} · recv {clock(view.receivedAt)}
                  </p>
                ))}
              </div>
              <ol className="mt-4 flex flex-col gap-2">
                {selected.events
                  .filter((e) => e.type !== "MATCH_CREATED")
                  .slice()
                  .reverse()
                  .map((event) => (
                    <li key={event.eventId} className="border-t border-line pt-2 text-sm">
                      <span className="text-signal">{event.type}</span> {event.clock ?? ""} {event.player ?? ""}{" "}
                      <span className="text-muted">
                        {event.provider} · certainty {event.certainty} · {event.backfill ? "already on the feed when we connected" : "seen while watching"}
                      </span>
                      {event.observations.length > 1 ? (
                        <span className="block text-muted">
                          Also seen by {event.observations.map((o) => `${o.provider} ${clock(o.receivedAt)}`).join(", ")}
                        </span>
                      ) : null}
                    </li>
                  ))}
              </ol>
            </article>
          ) : null}
        </section>

        <aside className="flex min-w-0 flex-col gap-4">
          <section className="border border-line bg-surface p-4">
            <h2 className="flex items-center gap-2 font-display text-2xl">
              <Radio className="size-5 text-signal" aria-hidden="true" />
              Providers
            </h2>
            <ul className="mt-3 flex flex-col gap-3">
              {board.providers.map((provider) => (
                <li key={provider.id} className="border border-line p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{provider.label}</p>
                    <p className={provider.health === "HEALTHY" ? "text-signal" : "text-muted"}>{provider.health}</p>
                  </div>
                  <p className="mt-1 break-words text-muted">{provider.detail}</p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted">
                    <dt>Live matches</dt>
                    <dd>{yn(provider.capabilities.supports_live_matches)}</dd>
                    <dt>Goal events</dt>
                    <dd>{yn(provider.capabilities.supports_goal_events)}</dd>
                    <dt>Push</dt>
                    <dd>{yn(provider.capabilities.supports_push)}</dd>
                    <dt>WebSocket</dt>
                    <dd>{yn(provider.capabilities.supports_websocket)}</dd>
                    <dt>SSE</dt>
                    <dd>{yn(provider.capabilities.supports_sse)}</dd>
                    <dt>Polling</dt>
                    <dd>{provider.capabilities.transport === "poll" ? "YES" : "NO"}</dd>
                    <dt>Event timestamp</dt>
                    <dd>{yn(provider.capabilities.supports_timestamps)}</dd>
                    <dt>Free</dt>
                    <dd>{yn(provider.capabilities.free)}</dd>
                    <dt>Trial</dt>
                    <dd>{yn(provider.capabilities.trial)}</dd>
                  </dl>
                  <p className="mt-2 break-words text-xs text-muted">{String(provider.capabilities.documented_latency ?? "")}</p>
                  <p className="mt-1 break-words text-xs text-muted">{String(provider.capabilities.upstream ?? "")}</p>
                </li>
              ))}
            </ul>
          </section>

          <Latency title="Internal processing" hint="Not detection. Body received to publish, on this server only." q={board.metrics.processing} />
          <Latency
            title="Poll gap upper bound"
            hint="Time since the previous poll when a change arrived. Not the goal instant. Empty for a push line, because a drain interval is not detection."
            q={board.metrics.detectionUpperBound}
          />
          <Latency
            title="Provider event stamp to our receipt"
            hint="Only when that provider sent an event timestamp. Unavailable means the feed did not send one. Not estimated."
            q={board.metrics.providerStampToReceive}
          />

          <section className="border border-line bg-surface p-4 text-sm">
            <h2 className="font-display text-2xl">Counts</h2>
            <p className="mt-2 text-muted">
              Received {board.metrics.received} · Published {board.metrics.published} · Duplicates {board.metrics.duplicates} ·
              Conflicts {board.metrics.conflicts} · Malformed {board.metrics.malformed} · Failures {board.metrics.failed} · Out of
              order {board.metrics.outOfOrder}
            </p>
            <p className="mt-2 text-muted">Journal rows in memory {board.journalCount}. Raw payloads are written to the database off the hot path.</p>
          </section>

          <section className="border border-line bg-surface p-4 text-sm">
            <h2 className="font-display text-2xl">Connect a feed</h2>
            <p className="mt-2 text-muted">
              Keys stay in server memory for this process. They are not written to disk and not sent back to the browser. A delayed Betfair key is refused. Sportradar stays idle even with a token, because a fixture id would have to be invented.
            </p>
            <label className="mt-3 block text-muted" htmlFor="provider-key">
              Provider
            </label>
            <select
              id="provider-key"
              className="mt-1 min-h-11 w-full border border-line bg-bg px-2"
              value={keyProvider}
              onChange={(e) => setKeyProvider(e.target.value)}
            >
              <option value="api-football">API-Football</option>
              <option value="sportmonks">Sportmonks</option>
              <option value="betfair">Betfair live app key</option>
            </select>
            <label className="mt-3 block text-muted" htmlFor="secret">
              {keyProvider === "betfair" ? "App key" : "Key"}
            </label>
            <input
              id="secret"
              type="password"
              autoComplete="off"
              suppressHydrationWarning
              className="mt-1 min-h-11 w-full border border-line bg-bg px-2"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
            />
            {keyProvider === "betfair" ? (
              <>
                <label className="mt-3 block text-muted" htmlFor="bf-session">
                  Session token
                </label>
                <input
                  id="bf-session"
                  type="password"
                  autoComplete="off"
                  suppressHydrationWarning
                  className="mt-1 min-h-11 w-full border border-line bg-bg px-2"
                  value={keySession}
                  onChange={(e) => setKeySession(e.target.value)}
                />
                <label className="mt-3 block text-muted" htmlFor="bf-tier">
                  Key tier
                </label>
                <select
                  id="bf-tier"
                  className="mt-1 min-h-11 w-full border border-line bg-bg px-2"
                  value={keyTier}
                  onChange={(e) => setKeyTier(e.target.value)}
                >
                  <option value="live">Live</option>
                  <option value="delayed">Delayed (refused)</option>
                </select>
              </>
            ) : null}
            <button type="button" className="mt-3 min-h-11 bg-signal px-4 text-signal-ink" onClick={() => void saveKey()}>
              Store key
            </button>
            {keyNote ? <p className="mt-2 text-muted">{keyNote}</p> : null}
          </section>

          <section className="border border-line bg-surface p-4 text-sm">
            <h2 className="font-display text-2xl">Replay</h2>
            <p className="mt-2 text-muted">
              Replays a real ESPN scoreboard fragment captured on 6 Oct 2026 through a fresh engine. It does not enter the live match
              list.
            </p>
            <button type="button" className="mt-3 min-h-11 border border-line px-4" onClick={() => void runReplay()}>
              Replay captured payload
            </button>
            <button type="button" className="mt-3 ml-2 min-h-11 border border-line px-4" onClick={() => void enableNotifications()}>
              {notifyOn ? "Notifications on" : "Notify on goals"}
            </button>
            <ul className="mt-3 flex flex-col gap-1 text-muted">
              {replay.map((event) => (
                <li key={event.eventId}>
                  {event.type} {event.homeTeam} {event.scoreHome}-{event.scoreAway} {event.awayTeam} {event.clock} · {event.player}
                </li>
              ))}
            </ul>
          </section>

          {board.recentConflicts.length > 0 ? (
            <section className="border border-line bg-surface p-4 text-sm">
              <h2 className="font-display text-2xl">Conflicts</h2>
              <ul className="mt-2 flex flex-col gap-2">
                {board.recentConflicts.slice(0, 6).map((conflict, i) => (
                  <li key={`${conflict.at}-${i}`} className="text-muted">
                    {conflict.homeTeam} vs {conflict.awayTeam}: {conflict.detail}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="text-xs leading-relaxed text-muted">
            ESPN is the baseline public scoreboard: poll about 8 seconds, no push. OpenLigaDB is a community reference, poll about 30 seconds. API-Football documents a 15-second refresh. Sportmonks documents a 10-second cycle and says it is not a websocket. Betfair can push a Goal suspension only with a live app key, and that is a market halt, not a confirmed goal. Sportradar Live Actions is the venue-style push product and is not connected: it needs a contract and a real fixture id. No advantage is shown until two watched sources report the same event.
          </p>
        </aside>
      </div>
    </main>
  );
}

function yn(value: unknown): string {
  if (value === true) return "YES";
  if (value === false) return "NO";
  return "UNKNOWN";
}

function SourceRacePanel({
  races,
  clientReceived,
}: {
  races: Race[];
  clientReceived: Record<string, string>;
}) {
  const compared = races.filter((race) => race.verdict === "OBSERVED ADVANTAGE" || race.verdict === "NO OBSERVED ADVANTAGE");
  const names = [...new Set(compared.flatMap((race) => race.rows.filter((row) => !row.backfill).map((row) => row.provider)))];
  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-6xl px-4 py-5 md:px-8">
        <h2 className="font-display text-3xl tracking-wide">Source race</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Receipt time versus the ESPN baseline. A goal is not a goal until a provider reports it. A fast socket is not a fast goal.
        </p>
        {compared.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Not measured. No event has been seen on two providers that were already watching.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {names.map((name) => {
              const wins = compared.filter((race) => race.fastestProvider === name).length;
              return (
                <li key={name}>
                  {name} was fastest on {wins} of {compared.length} compared events. Not a standing ranking.
                </li>
              );
            })}
          </ul>
        )}
        {races.length === 0 ? (
          <p className="mt-4 border border-line bg-surface p-4 text-sm text-muted">
            No measured advantage. ESPN is polled about every 8 seconds and OpenLigaDB about every 30 seconds. Neither pushes. A number appears only when the same goal is seen on two providers while both were already watching. First sight of a match is backfill, not a latency result.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {races.slice(0, 8).map((race) => (
              <RaceCard key={race.id} race={race} clientAt={clientReceived[race.id] ?? clientReceived[race.id.replace(/^pair_/, "")] ?? null} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function RaceCard({ race, clientAt }: { race: Race; clientAt: string | null }) {
  const advantage =
    race.advantageVsBaselineMs === null
      ? "not measured"
      : race.verdict === "OBSERVED ADVANTAGE"
        ? `${(race.advantageVsBaselineMs / 1000).toFixed(1)} seconds before ESPN`
        : race.verdict === "NO OBSERVED ADVANTAGE"
          ? "no observed advantage"
          : `${race.advantageVsBaselineMs.toFixed(0)} ms`;
  return (
    <li className="border border-line bg-surface p-4 text-sm">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="font-display text-2xl leading-none">
          {race.homeTeam} {race.scoreHome ?? "—"}–{race.scoreAway ?? "—"} {race.awayTeam}
        </p>
        <p className="text-signal">{race.verdict}</p>
      </div>
      <p className="mt-1 text-muted">
        {race.type.replaceAll("_", " ")} · {race.clock ?? "clock unavailable"} · {race.method} · fastest {race.fastestProvider ?? "none yet"} · advantage {advantage}
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {race.rows.map((row) => (
          <li key={`${race.id}-${row.provider}`} className="border-t border-line pt-2">
            <p className="font-medium">
              {row.provider}
              {row.backfill ? " · backfill, not a measurement" : ""}
            </p>
            <p className="text-muted">Provider event timestamp: {row.providerEventTimestamp ? clock(row.providerEventTimestamp) : "unavailable"}</p>
            <p className="text-muted">Provider publication timestamp: {row.providerPublicationTimestamp ? clock(row.providerPublicationTimestamp) : "unavailable"}</p>
            <p className="text-muted">Server receive: {clock(row.receivedAt)}</p>
            <p className="text-muted">Server parse: {row.serverParseTimestamp ? clock(row.serverParseTimestamp) : "unavailable"}</p>
            <p className="text-muted">Server publish: {row.serverPublishTimestamp ? clock(row.serverPublishTimestamp) : "unavailable"}</p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-muted">Client receive: {clientAt ? clock(clientAt) : "unavailable"} · this browser’s receipt of our message, not the goal</p>
      <p className="mt-1 text-muted">{race.note}</p>
    </li>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={"min-h-11 px-3 text-sm " + (active ? "bg-signal text-signal-ink" : "border border-line text-fg")}
    >
      {children}
    </button>
  );
}

function Latency({ title, hint, q }: { title: string; hint: string; q: Quantiles }) {
  return (
    <section className="border border-line bg-surface p-4 text-sm">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mt-1 text-muted">{hint}</p>
      {q.n === 0 ? (
        <p className="mt-3 text-muted">No measurements yet.</p>
      ) : (
        <dl className="mt-3 grid grid-cols-4 gap-2">
          <Stat k="n" v={String(q.n)} />
          <Stat k="p50" v={ms(q.p50)} />
          <Stat k="p95" v={ms(q.p95)} />
          <Stat k="p99" v={ms(q.p99)} />
          <Stat k="max" v={ms(q.max)} />
        </dl>
      )}
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-muted">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

function reduceBoard(board: PublicBoard, msg: Wire): PublicBoard {
  if (msg.kind === "snapshot" && msg.board) return msg.board;
  if (msg.kind === "providers" && msg.providers) return { ...board, providers: msg.providers, serverNow: new Date().toISOString() };
  if (msg.kind === "match" && msg.match) {
    const rest = board.matches.filter((m) => m.matchId !== msg.match!.matchId);
    return { ...board, matches: [...rest, msg.match], serverNow: new Date().toISOString() };
  }
  if (msg.kind === "event" && msg.event && !msg.event.replay) {
    const matches = board.matches.map((match) => {
      if (match.matchId !== msg.event!.matchId) return match;
      const events = [...match.events.filter((e) => e.eventId !== msg.event!.eventId), msg.event!].slice(-40);
      return { ...match, lastEvent: msg.event!, events };
    });
    return { ...board, matches, serverNow: new Date().toISOString() };
  }
  return board;
}

function sortMatches(a: PublicMatch, b: PublicMatch): number {
  const rank = (s: string) => (s === "IN_PLAY" ? 0 : s === "HALFTIME" ? 1 : s === "SCHEDULED" ? 2 : 3);
  return rank(a.status) - rank(b.status) || a.homeTeam.localeCompare(b.homeTeam);
}

function score(n: number | null): string {
  return n === null ? "—" : String(n);
}

function clock(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 23);
}

function ms(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "unavailable";
  return `${value.toFixed(0)} ms`;
}
