/**
 * A run: two seats on one screen, each with its own negotiator loop.
 *
 * Both seats watch the same negotiation and only the one Index says holds the
 * move ever acts, so the two loops need no lock between them. A seat that has
 * asked its principal something stops entirely until the answer arrives —
 * that pause is the whole point of the floor.
 */

import { config } from "./config.ts";
import { Index, type Turn } from "./index-api.ts";
import { decide } from "./negotiate.ts";
import { provision, type SeatInput, type SeatKind } from "./provision.ts";

export type SeatStatus = "waiting" | "negotiating" | "asking" | "matched" | "rejected" | "stalled" | "error";

const SETTLED: SeatStatus[] = ["matched", "rejected", "stalled"];

interface Seat {
  slot: "a" | "b";
  /** A guest is a real account. The floor watches their seat and never writes to it. */
  kind: SeatKind;
  name: string;
  intentText: string;
  userId: string;
  email: string;
  apiKey: string;
  api: Index;
  guidance: string[];
  question: string | null;
  status: SeatStatus;
  activity: string | null;
  error: string | null;
  opportunityId: string | null;
  busy: boolean;
  /** On means the agent is never offered the ask verb and decides on its own. */
  autoAnswer: boolean;
}

interface Run {
  id: string;
  networkId: string | null;
  password: string | null;
  state: "provisioning" | "live" | "failed";
  phase: string;
  error: string | null;
  startedAt: number;
  seats: Seat[];
  turns: Turn[];
  listeners: Set<(snapshot: string) => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const runs = new Map<string, Run>();
const MAX_RUNS = 20;

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function snapshot(run: Run): string {
  const slotOf = new Map(run.seats.map((seat) => [seat.userId, seat.slot]));
  return JSON.stringify({
    runId: run.id,
    state: run.state,
    phase: run.phase,
    error: run.error,
    elapsed: Math.round((Date.now() - run.startedAt) / 1000),
    seats: run.seats.map((seat) => ({
      slot: seat.slot,
      kind: seat.kind,
      name: seat.name,
      intent: seat.intentText,
      status: seat.status,
      question: seat.question,
      activity: seat.activity,
      error: seat.error,
      autoAnswer: seat.autoAnswer,
    })),
    turns: run.turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      slot: slotOf.get(turn.seatUserId) ?? null,
      action: turn.action,
      message: turn.message,
    })),
  });
}

export function subscribe(run: Run, send: (snapshot: string) => void): () => void {
  run.listeners.add(send);
  send(snapshot(run));
  return () => run.listeners.delete(send);
}

function broadcast(run: Run): void {
  const payload = snapshot(run);
  for (const send of run.listeners) send(payload);
}

/** Start a run and return as soon as it has an id; provisioning reports over the stream. */
export function startRun(seats: SeatInput[]): Run {
  const run: Run = {
    id: crypto.randomUUID().slice(0, 8),
    networkId: null,
    password: null,
    state: "provisioning",
    phase: "warming up",
    error: null,
    startedAt: Date.now(),
    seats: [],
    turns: [],
    listeners: new Set(),
    timer: null,
  };

  runs.set(run.id, run);
  if (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest) stopRun(oldest);
  }

  void (async () => {
    try {
      const provisioned = await provision(seats, (phase) => {
        run.phase = phase;
        broadcast(run);
      });

      run.networkId = provisioned.networkId;
      run.password = provisioned.password;
      run.seats = provisioned.seats.map((seat, position) => ({
        slot: seat.slot,
        kind: seat.kind,
        name: seat.name,
        intentText: seats[position]?.intent.trim() ?? "",
        userId: seat.userId,
        email: seat.email,
        apiKey: seat.apiKey,
        api: new Index({ key: seat.apiKey }),
        guidance: [],
        question: null,
        status: "waiting",
        activity: null,
        error: null,
        opportunityId: null,
        busy: false,
        autoAnswer: seats[position]?.autoAnswer ?? true,
      }));
      run.state = "live";
      run.phase = "discovery is scoring the match";
      broadcast(run);

      run.timer = setInterval(() => void tick(run), config.pollMs);
      void tick(run);
    } catch (cause) {
      run.state = "failed";
      run.error = cause instanceof Error ? cause.message : String(cause);
      broadcast(run);
    }
  })();

  return run;
}

export function stopRun(id: string): void {
  const run = runs.get(id);
  if (run?.timer) clearInterval(run.timer);
  runs.delete(id);
}

/** An answer from the person playing this seat. It unblocks them and holds for the rest of the run. */
export function answer(run: Run, slot: string, text: string): boolean {
  const seat = run.seats.find((candidate) => candidate.slot === slot);
  if (!seat?.question) return false;

  seat.guidance.push(`${seat.question} — ${text}`);
  seat.question = null;
  seat.status = "negotiating";
  seat.activity = "your agent is picking it back up";
  broadcast(run);
  void tickSeat(run, seat);
  return true;
}

/**
 * What it takes to sign in as a seat and to speak as its negotiator.
 *
 * Deliberately not part of `snapshot()`: that payload is rebroadcast to every
 * listener every few seconds, and a secret has no business in a stream.
 */
export function credentials(run: Run): { password: string | null; seats: unknown[] } {
  return {
    password: run.password,
    // Guests are excluded on purpose: their key is a real credential for a real
    // account, handed to the floor in its env, and is not the floor's to show.
    seats: run.seats.filter((seat) => seat.kind === "disposable").map((seat) => ({
      slot: seat.slot,
      name: seat.name,
      email: seat.email,
      userId: seat.userId,
      apiKey: seat.apiKey,
    })),
  };
}

/** Switch a seat between deciding for itself and stopping to ask its principal. */
export function setAutoAnswer(run: Run, slot: string, autoAnswer: boolean): boolean {
  const seat = run.seats.find((candidate) => candidate.slot === slot);
  if (!seat || seat.kind === "guest") return false;

  seat.autoAnswer = autoAnswer;
  // Switching it on means stop asking me — including the question already on
  // screen, which would otherwise block a seat nobody is answering for.
  if (autoAnswer && seat.question) {
    seat.question = null;
    if (seat.status === "asking") seat.status = "negotiating";
  }

  broadcast(run);
  // Pick it up on the spot rather than making the person wait out a poll.
  void tickSeat(run, seat);
  return true;
}

async function tick(run: Run): Promise<void> {
  await Promise.all(run.seats.map((seat) => tickSeat(run, seat)));
  if (run.seats.length && run.seats.every((seat) => SETTLED.includes(seat.status)) && run.timer) {
    clearInterval(run.timer);
    run.timer = null;
  }
}

async function tickSeat(run: Run, seat: Seat): Promise<void> {
  if (seat.busy || seat.question || SETTLED.includes(seat.status)) return;
  seat.busy = true;

  try {
    if (!seat.opportunityId) {
      const { negotiations } = await seat.api.listOpenNegotiations();
      const first = negotiations[0];
      if (!first) {
        seat.status = "waiting";
        return;
      }
      seat.opportunityId = first.opportunityId;
      run.phase = "the agents have been seated";
    }

    const negotiation = await seat.api.readNegotiation(seat.opportunityId);
    seat.error = null;
    if (negotiation.turns?.length) run.turns = negotiation.turns;

    if (negotiation.outcome) {
      seat.status = negotiation.outcome === "agreed" ? "matched" : "rejected";
      seat.activity = null;
      return;
    }
    // A guest's own agent answers for them. The floor reads the exchange so the
    // lane stays live and stops there — it has no business writing to a real
    // account, and two agents on one seat would race for the same turn.
    if (seat.kind === "guest") {
      seat.status = "negotiating";
      seat.activity = negotiation.awaitingUserId === seat.userId ? "waiting on their own agent" : null;
      return;
    }

    if (negotiation.awaitingUserId !== seat.userId) {
      seat.status = "negotiating";
      seat.activity = null;
      return;
    }
    if ((negotiation.turns?.length ?? 0) >= config.maxTurns) {
      seat.status = "stalled";
      seat.activity = null;
      return;
    }

    seat.status = "negotiating";
    seat.activity = "your agent is deciding its next turn";
    broadcast(run);

    const decision = await decide(negotiation, seat.userId, seat.intentText, seat.guidance, seat.autoAnswer);
    if (decision.action === "ask") {
      seat.question = decision.question;
      seat.status = "asking";
      seat.activity = null;
      return;
    }

    seat.activity = `sending ${decision.action}`;
    broadcast(run);
    const after = await seat.api.submitTurn(seat.opportunityId, decision.action, decision.message);
    if (after.turns?.length) run.turns = after.turns;
    seat.activity = null;
    if (after.outcome) seat.status = after.outcome === "agreed" ? "matched" : "rejected";
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Losing a race or reading a settled seat is ordinary: the next pass sees
    // the real state. Anything else is worth showing the operator.
    if (/not your turn|moved first|already settled/i.test(message)) {
      seat.activity = null;
    } else {
      seat.error = message;
      seat.status = "error";
    }
  } finally {
    seat.busy = false;
    broadcast(run);
  }
}
