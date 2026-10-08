import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/intel/shell";
import type { PublicBoard } from "@/engine/model";

const loadBoard = createServerFn({ method: "GET" }).handler(async (): Promise<PublicBoard> => {
  const { getRuntime } = await import("@/server/runtime.server");
  const rt = getRuntime();
  await rt.whenFirstCycle();
  return rt.publicBoard();
});

export const Route = createFileRoute("/")({
  loader: () => loadBoard(),
  component: Home,
});

function Home() {
  const initial = Route.useLoaderData();
  return <AppShell initial={initial} />;
}
