import { assertConfigured, config } from "./config.ts";
import { answer, getRun, setSeatSettings, snapshot, startRun, subscribe } from "./run.ts";
import type { SeatInput } from "./provision.ts";

assertConfigured();

const page = new URL("./web/index.html", import.meta.url);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function parseSeats(body: unknown): SeatInput[] | null {
  const seats = (body as { seats?: unknown })?.seats;
  if (!Array.isArray(seats) || seats.length !== 2) return null;

  const parsed = seats.map((seat) => {
    const row = seat as Partial<SeatInput>;
    return {
      name: typeof row.name === "string" ? row.name.slice(0, 80) : "",
      intent: typeof row.intent === "string" ? row.intent.slice(0, 2000) : "",
      profile: typeof row.profile === "string" ? row.profile.slice(0, 2000) : undefined,
      location: typeof row.location === "string" ? row.location.slice(0, 200) : undefined,
      mayAsk: row.mayAsk !== false,
    };
  });

  return parsed.every((seat) => seat.intent.trim()) ? parsed : null;
}

/** One run at a time per caller, so a reload cannot mint accounts in a loop. */
const lastRunAt = new Map<string, number>();
const RUN_COOLDOWN_MS = 20_000;

const server = Bun.serve({
  port: config.port,
  idleTimeout: 120,

  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(page), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/runs" && request.method === "POST") {
      const caller = server.requestIP(request)?.address ?? "unknown";
      const since = Date.now() - (lastRunAt.get(caller) ?? 0);
      if (since < RUN_COOLDOWN_MS) {
        return json({ error: `One run at a time. Try again in ${Math.ceil((RUN_COOLDOWN_MS - since) / 1000)}s.` }, 429);
      }

      const seats = parseSeats(await request.json().catch(() => null));
      if (!seats) return json({ error: "Two seats are required, each with an intent." }, 400);

      lastRunAt.set(caller, Date.now());
      return json({ runId: startRun(seats).id });
    }

    const events = url.pathname.match(/^\/api\/runs\/([\w-]+)\/events$/);
    if (events) {
      const run = getRun(events[1]!);
      if (!run) return json({ error: "No such run" }, 404);

      let unsubscribe = () => {};
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const send = (payload: string) => {
              try {
                controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
              } catch {
                unsubscribe();
              }
            };
            // Proxies drop a stream that says nothing; a comment is not an event.
            const keepAlive = setInterval(() => send(snapshot(run)), 20_000);
            const off = subscribe(run, send);
            unsubscribe = () => {
              clearInterval(keepAlive);
              off();
            };
          },
          cancel() {
            unsubscribe();
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          },
        },
      );
    }

    const answering = url.pathname.match(/^\/api\/runs\/([\w-]+)\/seats\/(a|b)\/answer$/);
    if (answering && request.method === "POST") {
      const run = getRun(answering[1]!);
      if (!run) return json({ error: "No such run" }, 404);

      const body = (await request.json().catch(() => null)) as { text?: string } | null;
      const text = body?.text?.trim().slice(0, 2000);
      if (!text) return json({ error: "An answer is required" }, 400);

      return answer(run, answering[2]!, text)
        ? json({ ok: true })
        : json({ error: "That seat is not waiting on you" }, 409);
    }

    const settings = url.pathname.match(/^\/api\/runs\/([\w-]+)\/seats\/(a|b)\/settings$/);
    if (settings && request.method === "POST") {
      const run = getRun(settings[1]!);
      if (!run) return json({ error: "No such run" }, 404);

      const body = (await request.json().catch(() => null)) as { enabled?: unknown; mayAsk?: unknown } | null;
      const changes = {
        ...(typeof body?.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body?.mayAsk === "boolean" ? { mayAsk: body.mayAsk } : {}),
      };
      if (!Object.keys(changes).length) return json({ error: "Nothing to change" }, 400);

      return setSeatSettings(run, settings[2]!, changes) ? json({ ok: true }) : json({ error: "No such seat" }, 404);
    }

    return json({ error: "Not found" }, 404);
  },
});

console.log(`the floor · ${server.url} → ${config.indexApiUrl}`);
