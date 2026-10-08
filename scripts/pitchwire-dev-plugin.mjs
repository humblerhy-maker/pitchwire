/** Dev-server hook: start ingestion, serve the live HTTP API, attach /ws/live. */

const PATHS = new Set([
  "/health",
  "/ready",
  "/metrics",
  "/matches",
  "/providers",
  "/latency",
  "/conflicts",
  "/journal",
  "/board",
  "/race",
  "/mode",
  "/replay",
  "/sse/live",
  "/credentials",
]);

function isPitchwirePath(path) {
  if (PATHS.has(path)) return true;
  if (path.startsWith("/matches/")) return true;
  if (path.startsWith("/providers/")) return true;
  return false;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export function pitchwireDevPlugin() {
  return {
    name: "pitchwire-dev",
    apply: "serve",
    async configureServer(server) {
      const httpMod = await server.ssrLoadModule("/src/server/http.server.ts");
      const socketMod = await server.ssrLoadModule("/src/server/dev-socket.server.ts");
      const rtMod = await server.ssrLoadModule("/src/server/runtime.server.ts");
      rtMod.getRuntime().start();
      if (server.httpServer) socketMod.attachLiveSocket(server.httpServer);

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? "").split("?", 1)[0] ?? "";
        if (!isPitchwirePath(path)) {
          next();
          return;
        }
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (key === "host" || key === "connection") continue;
            if (Array.isArray(value)) headers.set(key, value.join(", "));
            else headers.set(key, value);
          }
          const method = (req.method ?? "GET").toUpperCase();
          const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
          const request = new Request(`http://127.0.0.1:8080${req.url}`, { method, headers, body });
          const response = await httpMod.handleLiveRequest(request);
          if (!response) {
            next();
            return;
          }
          res.statusCode = response.status;
          response.headers.forEach((value, key) => {
            if (key === "transfer-encoding") return;
            res.setHeader(key, value);
          });
          if (!response.body) {
            res.end();
            return;
          }
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          res.end();
        } catch (err) {
          console.error("[pitchwire]", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("pitchwire error");
          }
        }
      });
    },
  };
}
