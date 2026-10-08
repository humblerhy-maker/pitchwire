import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { getRuntime } from "./runtime.server.ts";

export function attachLiveSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  getRuntime().enableWebsocket();
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const path = url.split("?", 1)[0];
    if (path !== "/ws/live") return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const rt = getRuntime();
      rt.start();
      const unsubscribe = rt.subscribe((msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      });
      ws.on("close", unsubscribe);
      ws.on("error", unsubscribe);
    });
  });
}
