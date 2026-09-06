/**
 * One run's worth of Index: a cast of people, a private network only they are
 * in, a signal each, and a negotiation from the primary to everyone else.
 *
 * Everything here is a public call any account could make, bar two. Creating a
 * network is staff-only, and so is opening a negotiation by hand, so the floor
 * signs in as a staff operator for those steps and nothing else.
 *
 * The floor does not wait on discovery. Discovery decides whether a pair is
 * worth pairing, which is the right question for Index and the wrong one for a
 * simulator: you asked for these people to negotiate, so they negotiate.
 */

import { config } from "./config.ts";
import { Index, mintJwt, signIn, signUp } from "./index-api.ts";

export type SeatKind = "ephemeral" | "guest";

export interface SeatInput {
  name: string;
  intent: string;
  profile?: string;
  location?: string;
  /** Both are carried through to the seat's negotiator; nothing here provisions them. */
  enabled?: boolean;
  mayAsk?: boolean;
  /** Set to seat one of this floor's configured people instead of a fresh one. */
  guestEmail?: string;
}

export interface ProvisionedSeat {
  slot: string;
  kind: SeatKind;
  name: string;
  email: string;
  userId: string;
  intentId: string;
  /** A key for that person: minted for an ephemeral seat, from the env for a guest. */
  apiKey: string;
}

export interface ProvisionedRun {
  runId: string;
  networkId: string;
  /** One per run, shared by every ephemeral seat. Shown in the lane so you can sign in as them. */
  password: string;
  seats: ProvisionedSeat[];
}

let operator: { jwt: string; mintedAt: number } | null = null;

/** The staff JWT used only to create a run's network. Good for an hour; re-minted well short of that. */
async function operatorJwt(): Promise<string> {
  if (operator && Date.now() - operator.mintedAt < 45 * 60 * 1000) return operator.jwt;
  const session = await signIn(config.operatorEmail, config.operatorPassword);
  operator = { jwt: await mintJwt(session), mintedAt: Date.now() };
  return operator.jwt;
}

export async function provision(
  seats: SeatInput[],
  primary: string,
  onStep: (phase: string) => void,
): Promise<ProvisionedRun> {
  const runId = crypto.randomUUID().slice(0, 8);
  const password = `floor-${crypto.randomUUID()}`;

  onStep(`seating ${seats.length} people`);
  const cast = await Promise.all(seats.map((seat, position) => {
    const slot = String(position + 1);
    return seat.guestEmail ? admit(seat.guestEmail, slot) : register(seat, slot, runId, password);
  }));

  onStep("opening a private network");
  const staff = new Index({ jwt: await operatorJwt() });
  const network = await staff.call<{ network: { id: string } }>("POST", "/api/networks", {
    title: `Floor ${runId}`,
    joinPolicy: "invite_only",
    metadata: { floorLab: true, runId },
  });
  const networkId = network.network.id;
  for (const person of cast) {
    await staff.call("POST", `/api/networks/${networkId}/members`, {
      userId: person.userId,
      permissions: ["member"],
    });
  }

  // Every signal is the floor's to write, guests included: their key acts as
  // them. Order no longer matters, because nothing downstream waits on
  // discovery having seen a fully indexed network.
  onStep(`admitting ${cast.length} signals`);
  const intentIds = await Promise.all(cast.map(async (person, position) => {
    try {
      const created = await person.api.call<{ intentId: string }>("POST", "/api/intents", {
        description: seats[position]!.intent.trim(),
        networkIds: [networkId],
      });
      return created.intentId;
    } catch (cause) {
      // Index turns away a signal it cannot act on, and says why. Name the
      // seat, or the person cannot tell which part of the run to rewrite.
      const why = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Index would not take ${person.name}'s signal. ${why}`);
    }
  }));

  onStep("giving each seat a negotiator");
  const keys = await Promise.all(cast.map((person) =>
    person.kind === "guest" ? person.apiKey : negotiatorKey(person, person.slot)));

  onStep("opening the negotiations");
  await pairOff(staff, networkId, primary, cast, intentIds);

  return {
    runId,
    networkId,
    password,
    seats: cast.map((person, position) => ({
      slot: person.slot,
      kind: person.kind,
      name: person.name,
      email: person.email,
      userId: person.userId,
      intentId: intentIds[position]!,
      apiKey: keys[position]!,
    })),
  };
}

type Person = Awaited<ReturnType<typeof register | typeof admit>>;

/**
 * Open a negotiation from the primary to every other seat.
 *
 * The primary is named as the initiator, which is Index's way of saying who
 * owes the opening turn — so putting a guest in that chair means their agent
 * moves first, and putting an ephemeral player there means the floor does.
 *
 * Discovery still runs on each signal write and cannot be turned off. It may
 * open further pairs, between two non-primary seats, that the floor never
 * asked for; those are real negotiations and the run adopts them like any
 * other. Where it reaches a pair the floor also asked for, Index's pair key
 * makes whichever arrives second a no-op.
 */
async function pairOff(
  staff: Index,
  networkId: string,
  primary: string,
  cast: Person[],
  intentIds: string[],
): Promise<void> {
  const at = cast.findIndex((person) => person.slot === primary);
  const initiator = intentIds[at];
  if (!initiator) throw new Error(`Slot ${primary} is not on this floor, so nobody can open.`);

  await Promise.all(cast.map(async (person, position) => {
    if (position === at) return;
    try {
      await staff.call("POST", "/api/negotiations/open", {
        networkId,
        initiatorIntentId: initiator,
        responderIntentId: intentIds[position],
      });
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Index would not open ${cast[at]!.name}'s negotiation with ${person.name}. ${why}`);
    }
  }));
}

async function register(seat: SeatInput, slot: string, runId: string, password: string) {
  const email = `floor+${runId}+${slot}@${config.seatEmailDomain}`;
  const name = seat.name.trim() || `Player ${slot}`;
  const { userId, session } = await signUp(email, password, name);
  const api = new Index({ jwt: await mintJwt(session) });

  const intro = seat.profile?.trim();
  const location = seat.location?.trim();
  if (intro || location) {
    await api.call("PATCH", "/api/auth/profile/update", {
      ...(intro ? { intro } : {}),
      ...(location ? { location } : {}),
    });
  }

  // The session outlives the JWT it minted: Better Auth will only mint a key
  // for a session, so a seat that has thrown one away cannot get a negotiator.
  return { kind: "ephemeral" as const, slot, name, email, userId, api, session };
}

/**
 * Seat one of this floor's configured people, using the key their env entry
 * carries.
 *
 * The key decides who this is; the address beside it is only a label. Checking
 * the two against each other is what stops a mispaired entry writing a signal
 * into somebody else's account — an accident nobody would notice until the
 * wrong person got an email about a negotiation.
 */
async function admit(email: string, slot: string) {
  const guest = config.guests.find((candidate) => candidate.email === email.trim().toLowerCase());
  if (!guest) throw new Error(`${email} is not one of this floor's people.`);

  const api = new Index({ key: guest.apiKey });
  let account: Awaited<ReturnType<Index["me"]>>;
  try {
    account = await api.me();
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`The key configured for ${guest.email} did not open an Index account. ${why}`);
  }

  if (account.email.trim().toLowerCase() !== guest.email) {
    throw new Error(`The key configured for ${guest.email} opens ${account.email}'s account instead. Fix FLOOR_GUESTS.`);
  }

  return {
    kind: "guest" as const,
    slot,
    name: account.name?.trim() || guest.email.split("@")[0]!,
    email: guest.email,
    userId: account.id,
    api,
    apiKey: guest.apiKey,
  };
}

/**
 * The agent that answers for this seat, and the key the floor speaks with.
 *
 * These are two separate things: a key authenticates the person and says
 * nothing about agents, and the negotiator is whichever agent that person
 * selected to handle negotiations. Selecting one takes the seat's JWT; minting
 * a key takes its session, because a key can never mint a successor.
 */
async function negotiatorKey(person: { api: Index; session: string }, slot: string): Promise<string> {
  const created = await person.api.call<{ agent: { id: string } }>("POST", "/api/agents", {
    name: `Floor seat ${slot}`,
  });
  await person.api.call("PATCH", `/api/agents/${created.agent.id}`, { handleNegotiations: true });

  const minted = await new Index({ jwt: person.session }).call<{ key: string }>(
    "POST",
    "/api/auth/api-key/create",
    { name: `Floor seat ${slot}` },
  );
  return minted.key;
}
