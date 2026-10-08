import { useEffect, useState } from "react";
import { Dashboard } from "@/components/console/dashboard";
import type { PublicBoard } from "@/engine/model";
import { findSelections, predictionHistory, providerHealth, saveKeys, settleNow, verifyPicks } from "@/intel/api";

type Tab = "finder" | "verify" | "live" | "history" | "settings";
type FinderResult = Awaited<ReturnType<typeof findSelections>>;
type VerifyResult = Awaited<ReturnType<typeof verifyPicks>>;
type HistoryResult = Awaited<ReturnType<typeof predictionHistory>>;

export function AppShell({ initial }: { initial: PublicBoard }) {
  const [tab, setTab] = useState<Tab>("finder");
  return (
    <div className="min-h-screen overflow-x-clip bg-bg text-fg">
      <header className="border-b border-line px-4 py-4 md:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-display text-4xl leading-none tracking-wide">PITCHWIRE</p>
            <p className="mt-1 max-w-xl text-sm text-muted">
              Sports intelligence. Strongest evidence we can actually read. Not a certainty, and not a short price.
            </p>
          </div>
          <nav className="flex flex-wrap gap-2">
            {(["finder", "verify", "live", "history", "settings"] as const).map((id) => (
              <button
                key={id}
                type="button"
                className={"min-h-11 px-3 text-sm capitalize " + (tab === id ? "bg-signal text-signal-ink" : "border border-line")}
                onClick={() => setTab(id)}
              >
                {id}
              </button>
            ))}
          </nav>
        </div>
      </header>
      {tab === "finder" ? <Finder /> : null}
      {tab === "verify" ? <Verify /> : null}
      {tab === "live" ? <Dashboard initial={initial} /> : null}
      {tab === "history" ? <History /> : null}
      {tab === "settings" ? <Settings /> : null}
    </div>
  );
}

function Finder() {
  const [text, setText] = useState("I need the strongest football and basketball markets today.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<FinderResult | null>(null);

  async function run() {
    setBusy(true);
    setError("");
    try {
      setResult(await findSelections({ data: { text } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Finder failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-6xl px-4 py-5 md:px-8">
      <label className="text-sm text-muted" htmlFor="finder-request">
        Finder
      </label>
      <textarea
        id="finder-request"
        className="mt-2 min-h-24 w-full border border-line bg-surface px-3 py-2"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="button" className="mt-3 min-h-11 bg-signal px-4 text-signal-ink" disabled={busy} onClick={() => void run()}>
        {busy ? "Researching real feeds…" : "Run finder"}
      </button>
      {error ? <p className="mt-3 text-sm">{error}</p> : null}
      {result ? <FinderReport result={result} /> : null}
    </section>
  );
}

function FinderReport({ result }: { result: FinderResult }) {
  return (
    <div className="mt-6 flex flex-col gap-4">
      <p className="text-sm text-muted">
        Window {result.intent.window}
        {result.intent.combinedTarget != null ? ` · target combined ${result.intent.combinedTarget}` : ""} ·{" "}
        {result.intent.sports === "any" ? "any sport on the public scoreboards" : result.intent.sports.join(", ")}. A short
        price is not treated as safer. Receipt {result.receivedAt.slice(11, 19)} UTC.
      </p>
      {result.blocker ? <p className="border border-line bg-surface p-4 text-sm">{result.blocker}</p> : null}
      {result.issued.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {result.issued.map((row, index) => (
            <li key={row.id} className="border border-line bg-surface p-4">
              <p className="text-xs tracking-wide text-muted uppercase">
                {index + 1} · {row.sport} · {row.modelLabel ?? "Selection"}
                {row.competition ? ` · ${row.competition}` : ""}
              </p>
              <p className="mt-1 font-display text-3xl leading-none break-words">
                {row.home} vs {row.away}
              </p>
              <p className="mt-2 text-sm">
                {row.selection}
                {row.line != null ? ` ${row.line}` : ""} · {lagosWhen(row.start)}
              </p>
              <p className="mt-2 text-sm">Why: {row.reasons[0]}</p>
              <p className="mt-1 text-sm">Main risk: {row.gaps[0] ?? "Injuries and the exact 1xBet price were not verified."}</p>
              <p className="mt-1 text-sm">1xBet listing was not checked. Exact current price was not verified. Find the fixture and check it there.</p>
              <p className="mt-1 text-sm text-muted">
                {row.decimal > 1
                  ? `Observed ${row.bookmaker} ${row.decimal.toFixed(2)}. Not labeled 1xBet unless that book sent it. `
                  : "No public price was on the scoreboard. None was invented. "}
                Price time: {row.providerTimestamp ?? "unavailable"}.
              </p>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="text-sm text-muted">
        {result.slipNote}
        {result.combined != null ? ` Combined ${result.combined.toFixed(2)}.` : ""}{" "}
        {result.aiCalled ? "A model was called." : "No model was called."}
        {result.modelNotes.some((note) => note.cached) ? " Cached reply from this process." : ""}
      </p>
      {result.coverage ? (
        <p className="text-sm text-muted">
          Requested day uses Africa/Lagos. Dates queried {result.coverage.day}. Leagues known {result.coverage.leaguesKnown}.
          Scoreboards read {result.coverage.scoreboardsRead}. Events discovered {result.coverage.eventsDiscovered}. Inside the
          day {result.coverage.insideDay}. Outside the day {result.coverage.outsideDay}. Football inside the day{" "}
          {result.coverage.footballInside}, not started {result.coverage.footballPre}. Basketball inside the day{" "}
          {result.coverage.basketballInside}. Summaries read {result.coverage.summariesRead}. Screened{" "}
          {result.coverage.screened}. Cleared the evidence bar {result.coverage.survivors}. Sent for review{" "}
          {result.coverage.deepResearched}.
        </p>
      ) : null}
      {result.researchStop ? <p className="text-sm text-muted">{result.researchStop}</p> : null}
      <p className="text-sm text-muted">{result.injuryDetail}</p>
      {result.scanned.length > 0 ? (
        <p className="text-sm text-muted">
          Scanned {result.scanned.map((row) => `${row.sport} ${row.events} events / ${row.quotes} prices`).join(" · ")}
        </p>
      ) : (
        <p className="text-sm">No events were inside this window.</p>
      )}
      {result.outsideWindow.length > 0 ? (
        <p className="text-sm text-muted">
          Outside this window: {result.outsideWindow.map((row) => `${row.sport} ${row.events}`).join(" · ")}. The date is
          Africa/Lagos.
        </p>
      ) : null}
      {result.nearby.length > 0 ? (
        <ul className="text-sm text-muted">
          {result.nearby.map((row) => (
            <li key={`${row.home}-${row.start}`}>
              Not selected · {row.sport} · {row.home} vs {row.away} · {row.start ?? "time unavailable"}
            </li>
          ))}
        </ul>
      ) : null}
      {result.modelNotes.length > 0 ? (
        <section className="border border-line p-4 text-sm">
          <h2 className="font-display text-2xl">Model replies</h2>
          {result.modelNotes.map((note) => (
            <p key={`${note.provider}-${note.model}`} className="mt-2 text-muted">
              {note.provider} · {note.model} · {note.ok ? "responded" : "failed"}
              {note.cached ? " · cached" : ""}
            </p>
          ))}
        </section>
      ) : (
        <p className="text-sm text-muted">No model text. None was invented.</p>
      )}
    </div>
  );
}

function lagosWhen(iso: string | null): string {
  if (!iso) return "time unavailable";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "time unavailable";
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Lagos",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(when) + " WAT"
  );
}

function Verify() {
  const [text, setText] = useState("Richmond Kickers vs FC Naples — Over 3.5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<VerifyResult | null>(null);
  return (
    <section className="mx-auto max-w-6xl px-4 py-5 md:px-8">
      <label className="text-sm text-muted" htmlFor="verify-request">
        Verification. An outside pick is not treated as true.
      </label>
      <textarea
        id="verify-request"
        className="mt-2 min-h-28 w-full border border-line bg-surface px-3 py-2"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        className="mt-3 min-h-11 bg-signal px-4 text-signal-ink"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          void verifyPicks({ data: { text } })
            .then(setResult)
            .catch((err: unknown) => setError(err instanceof Error ? err.message : "Verification failed."))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Checking the feeds…" : "Verify"}
      </button>
      {error ? <p className="mt-3 text-sm">{error}</p> : null}
      <ul className="mt-4 flex flex-col gap-3">
        {result?.picks.map((pick) => (
          <li key={pick.raw} className="border border-line bg-surface p-4 text-sm">
            <p className="font-display text-2xl">{pick.status}</p>
            <p className="mt-1">{pick.raw}</p>
            <p className="mt-2 text-muted">{pick.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function History() {
  const [data, setData] = useState<HistoryResult | null>(null);
  const [note, setNote] = useState("");
  async function load() {
    const history = await predictionHistory();
    setData(history);
  }
  return (
    <section className="mx-auto max-w-6xl px-4 py-5 md:px-8">
      <button type="button" className="min-h-11 bg-signal px-4 text-signal-ink" onClick={() => void load()}>
        Load ledger
      </button>
      <button
        type="button"
        className="ml-2 min-h-11 border border-line px-4"
        onClick={() => void settleNow({ data: {} }).then((row) => setNote(`Settled ${row.settled} from final scores currently on the feeds.`))}
      >
        Settle finals
      </button>
      {note ? <p className="mt-3 text-sm text-muted">{note}</p> : null}
      {data ? (
        <div className="mt-4 text-sm">
          <p>
            Issued {data.calibration.issued}. Settled {data.calibration.settled}. Won {data.calibration.won}. Lost{" "}
            {data.calibration.lost}.
          </p>
          <p className="mt-1 text-muted">{data.calibration.note}</p>
          <ul className="mt-4 flex flex-col gap-2">
            {data.runs.length === 0 ? <li className="text-muted">No runs stored in this process yet.</li> : null}
            {data.runs.map((run) => (
              <li key={run.id} className="border border-line p-3">
                <span className="text-muted">{run.mode}</span> {run.request.slice(0, 180)}
                <span className="mt-1 block text-muted">{run.summary}</span>
              </li>
            ))}
          </ul>
          <ul className="mt-4 flex flex-col gap-2">
            {data.predictions.slice(0, 20).map((row) => (
              <li key={row.id} className="border border-line p-3">
                {row.home} vs {row.away} · {row.market} {row.selection}
                {row.line != null ? ` ${row.line}` : ""} · {row.outcome}
                <span className="mt-1 block text-muted">
                  {row.is1xBet ? "1xBet" : row.bookmaker ?? "book unavailable"} {row.odds ?? ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Settings() {
  const [gemini, setGemini] = useState("");
  const [groq, setGroq] = useState("");
  const [cohere, setCohere] = useState("");
  const [note, setNote] = useState("");
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof providerHealth>>["providers"]>([]);

  useEffect(() => {
    void providerHealth()
      .then((row) => setProviders(row.providers))
      .catch(() => setProviders([]));
  }, []);

  async function store(provider: "gemini" | "groq" | "cohere", value: string) {
    const result = await saveKeys({ data: { provider, keys: value } });
    setNote(`${provider}: stored ${result.stored}. ${result.validation}`);
    const health = await providerHealth();
    setProviders(health.providers);
    setGemini("");
    setGroq("");
    setCohere("");
  }

  return (
    <section className="mx-auto max-w-6xl px-4 py-5 md:px-8">
      <p className="max-w-2xl text-sm text-muted">
        Finder does not need an odds API key. It reads public scoreboards. A selection is issued only after a configured
        model returns an id from that packet. Keys stay in server memory. They are not written to the database and not
        shown again.
      </p>
      <ul className="mt-4 flex flex-col gap-1 text-sm">
        {providers.map((row) => (
          <li key={row.provider}>
            {row.provider} · {row.model} · {row.state}
            <span className="mt-1 block text-muted">{row.detail}</span>
          </li>
        ))}
      </ul>
      <KeyBox id="gemini-keys" label="Gemini keys" value={gemini} onChange={setGemini} onSave={() => void store("gemini", gemini)} />
      <KeyBox id="groq-keys" label="Groq keys" value={groq} onChange={setGroq} onSave={() => void store("groq", groq)} />
      <KeyBox id="cohere-keys" label="Cohere keys" value={cohere} onChange={setCohere} onSave={() => void store("cohere", cohere)} />
      {note ? <p className="mt-4 text-sm">{note}</p> : null}
      <p className="mt-4 text-sm text-muted">
        1xBet has no public odds API, so the exact 1xBet price is not required and is not invented. The result says to find
        the event and market there and check the current price. Grok is used when the app already has a reasoning key. That
        key is not pasted here.
      </p>
    </section>
  );
}

function KeyBox({
  id,
  label,
  value,
  onChange,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="mt-4">
      <label className="text-sm text-muted" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="mt-1 min-h-20 w-full border border-line bg-surface px-3 py-2"
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" className="mt-2 min-h-11 border border-line px-4 text-sm" onClick={onSave}>
        Store and check
      </button>
    </div>
  );
}
