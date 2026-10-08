import { createFileRoute } from "@tanstack/react-router";
import { handleLiveRequest } from "@/server/http.server";

export const Route = createFileRoute("/latency")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await handleLiveRequest(request)) ?? new Response("Not found", { status: 404 }),
    },
  },
});
