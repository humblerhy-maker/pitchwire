import { getRuntime } from "./runtime.server.ts";
import type { WireMessage } from "./runtime.server.ts";

export async function handleLiveRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = request.method.toUpperCase();
  const rt = getRuntime();
  rt.start();

  if (method === "GET" && path === "/health") {
    return json({ ok: true, mode: rt.mode, startedAt: rt.startedAt, serverNow: new Date().toISOString() });
  }
  if (method === "GET" && path === "/ready") {
    await rt.whenFirstCycle();
    return json({ ok: true, mode: rt.mode, providers: rt.publicBoard().providers.map((p) => ({ id: p.id, health: p.health })) });
  }
  if (method === "GET" && path === "/metrics") {
    return new Response(rt.prometheus(), {
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (method === "GET" && path === "/matches") {
    await rt.whenFirstCycle();
    return json({ mode: rt.mode, matches: rt.publicBoard().matches });
  }
  if (method === "GET" && path === "/providers") {
    return json({ providers: rt.publicBoard().providers });
  }
  if (method === "GET" && path === "/latency") {
    return json(rt.publicBoard().metrics);
  }
  if (method === "GET" && path === "/conflicts") {
    return json({ conflicts: rt.publicBoard().recentConflicts });
  }
  if (method === "GET" && path === "/journal") {
    return json({ events: rt.journalSlice(40) });
  }
  if (method === "GET" && path === "/board") {
    await rt.whenFirstCycle();
    return json(rt.publicBoard());
  }
  if (method === "GET" && path === "/race") {
    await rt.whenFirstCycle();
    const board = rt.publicBoard();
    return json({
      races: board.races,
      note: "A number is a receipt delta for one event both providers were already watching. It is not a ranking and not a 30- or 60-second claim. Provider event time is shown only when that provider sent one.",
    });
  }

  const match = path.match(/^\/matches\/([^/]+)$/);
  if (method === "GET" && match) {
    const found = rt.engine.getMatch(decodeURIComponent(match[1]!));
    if (!found) return json({ error: "Match not found" }, 404);
    return json(found);
  }
  const events = path.match(/^\/matches\/([^/]+)\/events$/);
  if (method === "GET" && events) {
    const found = rt.engine.getMatch(decodeURIComponent(events[1]!));
    if (!found) return json({ error: "Match not found" }, 404);
    return json({ matchId: found.matchId, events: found.events });
  }
  const provider = path.match(/^\/providers\/([^/]+)$/);
  if (method === "GET" && provider) {
    const id = decodeURIComponent(provider[1]!);
    const found = rt.publicBoard().providers.find((p) => p.id === id);
    if (!found) return json({ error: "Provider not found" }, 404);
    return json(found);
  }
  const health = path.match(/^\/providers\/([^/]+)\/health$/);
  if (method === "GET" && health) {
    const id = decodeURIComponent(health[1]!);
    const found = rt.publicBoard().providers.find((p) => p.id === id);
    if (!found) return json({ error: "Provider not found" }, 404);
    return json({ id: found.id, health: found.health, detail: found.detail, failures: found.failures, validation: found.validation });
  }

  if (method === "POST" && path === "/mode") {
    const body = (await request.json().catch(() => null)) as { mode?: string } | null;
    if (body?.mode !== "live" && body?.mode !== "demo") {
      return json({ error: "mode must be live or demo" }, 400);
    }
    return json(rt.setMode(body.mode));
  }
  if (method === "POST" && path === "/credentials") {
    const body = (await request.json().catch(() => null)) as {
      provider?: string;
      key?: string;
      session?: string;
      tier?: string;
    } | null;
    if (!body?.provider || typeof body.key !== "string") {
      return json({ error: "provider and key are required" }, 400);
    }
    return json(rt.setCredential(body.provider, body.key, { session: body.session, tier: body.tier }));
  }
  if (method === "POST" && path === "/replay") {
    const body = (await request.json().catch(() => null)) as {
      provider?: string;
      raw?: unknown;
      sample?: boolean;
    } | null;
    if (!body?.provider || (body.raw === undefined && body.sample !== true)) {
      return json({ error: "provider and raw are required" }, 400);
    }
    if (body.sample === true) {
      if (body.provider !== "espn") return json({ error: "sample replay is only stored for espn" }, 400);
      const { ESPN_SAMPLE } = await import("./sample-espn.ts");
      return json(await rt.replayFixture(ESPN_SAMPLE, "espn"));
    }
    const result = await rt.replayFixture(body.raw, body.provider);
    return json(result);
  }
  if (method === "GET" && path === "/sse/live") {
    return sseResponse(rt);
  }
  return null;
}

function sseResponse(rt: ReturnType<typeof getRuntime>): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (msg: WireMessage) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
        } catch {
          unsubscribe();
        }
      };
      unsubscribe = rt.subscribe(send);
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
