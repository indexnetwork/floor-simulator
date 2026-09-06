/**
 * A run: any number of people on one screen, and every negotiation between them.
 *
 * Index opens one negotiation per compatible pair, so a floor of five holds up
 * to ten of them at once and a single seat can be mid-sentence with four
 * counterparts. The run therefore keys negotiations by opportunity and treats a
 * seat as a person rather than as one side of one deal.
 *
 * Each pass has three phases. Discovery adopts negotiations the seats can see,
 * reading adopts their current state, and acting lets whichever seat holds the
 * move author a turn. A seat that has asked its principal something stops in
 * that one negotiation and carries on in the others.
 */

import { config } from "./config.ts";
import { Index, mintJwt, signIn, type Negotiation, type Turn } from "./index-api.ts";
import { decide } from "./negotiate.ts";
import { provision, type SeatInput, type SeatKind } from "./provision.ts";

/** Late pairs still arrive after the first ones settle; wait this long before letting a run go quiet. */
const IDLE_MS = 30_000;
/** How long a run may poll Index before it is left as it stands. */
const MAX_RUN_MS = 30 * 60_000;
/** Discovery only sees signals already indexed, so a first wave can miss pairs. Fix them after this. */
const RECONCILE_AFTER_MS = 60_000;

interface Seat {
  slot: string;
  /** A guest is a real account. The floor seats them and never writes a turn for them. */
  kind: SeatKind;
  name: string;
  intentText: string;
  intentId: string;
  userId: string;
  email: string;
  apiKey: string;
  api: Index;
  guidance: string[];
  error: string | null;
  /** Off means Floor's loop never runs for this seat. Its agent stays bound in Index either way. */
  enabled: boolean;
  /** On means the agent may stop and ask its principal instead of deciding alone. */
  mayAsk: boolean;
}

/** One negotiation between two of the seats. Index has no third side. */
interface Live {
  opportunityId: string;
  slots: [string, string];
  turns: Turn[];
  outcome: "agreed" | "declined" | "closed" | null;
  awaitingSlot: string | null;
  question: string | null;
  askedBy: string | null;
  activity: string | null;
  busy: boolean;
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
  live: Map<string, Live>;
  lastOpenedAt: number;
  reconciled: boolean;
  listeners: Set<(snapshot: string) => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

const runs = new Map<string, Run>();
const MAX_RUNS = 20;

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

const seatAt = (run: Run, slot: string | null): Seat | undefined =>
  slot === null ? undefined : run.seats.find((seat) => seat.slot === slot);

const mine = (run: Run, slot: string): Live[] =>
  [...run.live.values()].filter((live) => live.slots.includes(slot));

/** Settled to the floor: Index called it, or it spent the turn budget with the exchange still open. */
const settled = (live: Live): boolean => Boolean(live.outcome) || live.turns.length >= config.maxTurns;

/**
 * The lane header's one-word summary. Derived rather than stored: with several
 * negotiations per seat there is no single status to keep in sync.
 */
function seatStatus(run: Run, seat: Seat): string {
  if (seat.error) return "error";
  const held = mine(run, seat.slot);
  if (held.some((live) => live.askedBy === seat.slot && live.question)) return "asking";
  if (held.length && held.every(settled)) return "done";
  // "off" is about Floor's loop, which never ran for a guest in the first place.
  if (seat.kind === "guest") return "waiting";
  if (!seat.enabled) return "off";
  return held.length ? "negotiating" : "waiting";
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
      enabled: seat.enabled,
      mayAsk: seat.mayAsk,
      error: seat.error,
      status: seatStatus(run, seat),
    })),
    negotiations: [...run.live.values()].map((live) => ({
      opportunityId: live.opportunityId,
      slots: live.slots,
      outcome: live.outcome,
      stalled: !live.outcome && live.turns.length >= config.maxTurns,
      awaitingSlot: live.awaitingSlot,
      question: live.question,
      askedBy: live.askedBy,
      activity: live.activity,
      turns: live.turns.map((turn) => ({
        turnIndex: turn.turnIndex,
        slot: slotOf.get(turn.seatUserId) ?? null,
        action: turn.action,
        message: turn.message,
      })),
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
    live: new Map(),
    lastOpenedAt: Date.now(),
    reconciled: false,
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
        intentId: seat.intentId,
        userId: seat.userId,
        email: seat.email,
        apiKey: seat.apiKey,
        api: new Index({ key: seat.apiKey }),
        guidance: [],
        error: null,
        // A guest is never floor-driven: their own agent holds the seat.
        enabled: seat.kind === "disposable" && seats[position]?.enabled !== false,
        mayAsk: seats[position]?.mayAsk === true,
      }));
      run.state = "live";
      run.phase = "discovery is scoring the matches";
      broadcast(run);

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
  if (run?.timer) clearTimeout(run.timer);
  runs.delete(id);
}

/**
 * An answer from the person playing a seat.
 *
 * It unblocks the one negotiation that asked, then joins that seat's standing
 * brief — a ceiling or a date is a fact about the person, not about one deal,
 * so every counterpart they are talking to gets it too.
 */
export function answer(run: Run, opportunityId: string, text: string): boolean {
  const live = run.live.get(opportunityId);
  const seat = seatAt(run, live?.askedBy ?? null);
  if (!live?.question || !seat) return false;

  seat.guidance.push(`${live.question} — ${text}`);
  live.question = null;
  live.askedBy = null;
  live.activity = "picking it back up";
  broadcast(run);
  void tick(run);
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

/** Change whether Floor drives a seat, and whether its agent may stop to ask. */
export function setSwitches(run: Run, slot: string, changes: { enabled?: boolean; mayAsk?: boolean }): boolean {
  const seat = seatAt(run, slot);
  if (!seat || seat.kind === "guest") return false;

  if (changes.enabled !== undefined) seat.enabled = changes.enabled;
  if (changes.mayAsk !== undefined) {
    seat.mayAsk = changes.mayAsk;
    // Turning questions off means stop asking me — including the ones already
    // on screen, which would otherwise block negotiations nobody will answer.
    if (!seat.mayAsk) {
      for (const live of mine(run, seat.slot)) {
        if (live.askedBy !== seat.slot) continue;
        live.question = null;
        live.askedBy = null;
      }
    }
  }

  broadcast(run);
  // Pick it up on the spot rather than making the person wait out a poll.
  void tick(run);
  return true;
}

async function tick(run: Run): Promise<void> {
  if (run.state !== "live") return;
  if (run.timer) {
    clearTimeout(run.timer);
    run.timer = null;
  }

  await sight(run);
  await study(run);
  await mend(run);
  await play(run);

  broadcast(run);
  schedule(run);
}

/**
 * The next pass, spaced so the request rate holds roughly flat as the floor
 * fills up: ten players is forty-five negotiations, and polling all of them
 * every three seconds would be fifteen reads a second against Index.
 */
function schedule(run: Run): void {
  const done = run.live.size > 0
    && [...run.live.values()].every(settled)
    && Date.now() - run.lastOpenedAt > IDLE_MS;
  if (done || Date.now() - run.startedAt > MAX_RUN_MS) return;

  const wait = Math.max(config.pollMs, run.live.size * 400);
  run.timer = setTimeout(() => void tick(run), wait);
}

/** Adopt negotiations the seats can see and this run has not met yet. */
async function sight(run: Run): Promise<void> {
  await Promise.all(run.seats.map(async (seat) => {
    try {
      const { negotiations } = await seat.api.listOpenNegotiations();
      for (const found of negotiations) adopt(run, seat, found);
      seat.error = null;
    } catch (cause) {
      note(seat, cause);
    }
  }));
}

function adopt(run: Run, seat: Seat, found: Negotiation): void {
  if (run.live.has(found.opportunityId)) return;
  // A guest's account has a life outside this run. Only negotiations whose
  // other side is also on this floor belong on this screen.
  const other = run.seats.find((candidate) => candidate.userId === found.counterparty.userId);
  if (!other) return;

  const slots: [string, string] = seat.slot < other.slot ? [seat.slot, other.slot] : [other.slot, seat.slot];
  run.live.set(found.opportunityId, {
    opportunityId: found.opportunityId,
    slots,
    turns: [],
    outcome: null,
    awaitingSlot: null,
    question: null,
    askedBy: null,
    activity: null,
    busy: false,
  });
  run.lastOpenedAt = Date.now();
  run.phase = "the agents have been seated";
}

/** Read each open negotiation once, so the screen is current without reading it twice. */
async function study(run: Run): Promise<void> {
  const open = [...run.live.values()].filter((live) => !live.outcome && !live.busy);
  await Promise.all(open.map(async (live) => {
    for (const slot of live.slots) {
      const reader = seatAt(run, slot);
      if (!reader) continue;
      try {
        absorb(run, live, await reader.api.readNegotiation(live.opportunityId));
        reader.error = null;
        return;
      } catch (cause) {
        note(reader, cause);
      }
    }
  }));
}

function absorb(run: Run, live: Live, fresh: Negotiation): void {
  if (fresh.turns?.length) live.turns = fresh.turns;
  live.outcome = fresh.outcome;
  live.awaitingSlot = run.seats.find((seat) => seat.userId === fresh.awaitingUserId)?.slot ?? null;
  if (fresh.outcome) {
    live.activity = null;
    live.question = null;
    live.askedBy = null;
  }
}

/**
 * Open the pairs the first wave of discovery missed.
 *
 * Discovery runs per signal and only sees the peers already indexed, so signals
 * written together can leave holes — invisible with two seats, ordinary with
 * six. Pausing and resuming a signal runs its discovery again, this time
 * against a fully indexed network, and Index's pair key stops it duplicating
 * anything already open.
 */
async function mend(run: Run): Promise<void> {
  if (run.reconciled || Date.now() - run.startedAt < RECONCILE_AFTER_MS) return;
  run.reconciled = true;

  const holes = new Set<string>();
  for (const [index, one] of run.seats.entries()) {
    for (const other of run.seats.slice(index + 1)) {
      const paired = [...run.live.values()].some(
        (live) => live.slots.includes(one.slot) && live.slots.includes(other.slot),
      );
      if (!paired) {
        holes.add(one.slot);
        holes.add(other.slot);
      }
    }
  }
  if (!holes.size) return;

  run.phase = `nudging discovery for ${holes.size} signals`;
  broadcast(run);
  await Promise.all([...holes].map(async (slot) => {
    const seat = seatAt(run, slot)!;
    try {
      const owner = await principal(run, seat);
      await owner.call("PATCH", `/api/intents/${seat.intentId}/status`, { status: "PAUSED" });
      await owner.call("PATCH", `/api/intents/${seat.intentId}/status`, { status: "ACTIVE" });
    } catch (cause) {
      note(seat, cause);
    }
  }));
  run.phase = "the agents have been seated";
}

/**
 * The seat's own account rather than its negotiator.
 *
 * A negotiator key speaks for an agent and cannot touch its owner's signals. A
 * guest's key already is their account; a disposable seat signs back in, which
 * is what the run's shared password is for.
 */
async function principal(run: Run, seat: Seat): Promise<Index> {
  if (seat.kind === "guest") return seat.api;
  return new Index({ jwt: await mintJwt(await signIn(seat.email, run.password!)) });
}

/** Let every seat holding a move author its turn. */
async function play(run: Run): Promise<void> {
  const ready = [...run.live.values()].filter((live) => {
    if (live.busy || live.question || settled(live)) return false;
    const seat = seatAt(run, live.awaitingSlot);
    return Boolean(seat?.enabled);
  });
  await Promise.all(ready.map((live) => author(run, live)));
}

async function author(run: Run, live: Live): Promise<void> {
  const seat = seatAt(run, live.awaitingSlot)!;
  live.busy = true;

  try {
    // Read again as this seat: Index describes a negotiation from the caller's
    // side, and the counterpart's statement is what the agent is answering.
    const negotiation = await seat.api.readNegotiation(live.opportunityId);
    absorb(run, live, negotiation);
    if (negotiation.outcome || negotiation.awaitingUserId !== seat.userId) return;

    live.activity = "deciding its next turn";
    broadcast(run);

    const decision = await decide(negotiation, seat.userId, seat.intentText, seat.guidance, seat.mayAsk);
    if (decision.action === "ask") {
      live.question = decision.question;
      live.askedBy = seat.slot;
      live.activity = null;
      return;
    }

    live.activity = `sending ${decision.action}`;
    broadcast(run);
    absorb(run, live, await seat.api.submitTurn(live.opportunityId, decision.action, decision.message));
    live.activity = null;
    seat.error = null;
  } catch (cause) {
    live.activity = null;
    note(seat, cause);
  } finally {
    live.busy = false;
    broadcast(run);
  }
}

/**
 * Losing a race or reading a settled negotiation is ordinary with this many
 * loops in flight: the next pass sees the real state. Anything else is worth
 * showing the operator.
 */
function note(seat: Seat, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/not your turn|moved first|already settled/i.test(message)) return;
  seat.error = message;
}
