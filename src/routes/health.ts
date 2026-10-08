import { createFileRoute } from "@tanstack/react-router";
import { handleLiveRequest } from "@/server/http.server";

async function go(request: Request): Promise<Response> {
  return (await handleLiveRequest(request)) ?? new Response("Not found", { status: 404 });
}

export const Route = createFileRoute("/health")({
  server: { handlers: { GET: ({ request }) => go(request) } },
});
