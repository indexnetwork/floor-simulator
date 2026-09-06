/**
 * One run's worth of Index: a cast of people, a private network only they are
 * in, a signal each, and a negotiator agent for everyone the floor will drive.
 *
 * Everything here is a public call any account could make. The old floor lab
 * wrote these rows directly because it ran inside the API; from outside, the
 * one thing a fresh account cannot do is create a network, so the floor signs
 * in as a staff operator for that step and nothing else.
 */

import { config } from "./config.ts";
import { Index, mintJwt, signIn, signUp } from "./index-api.ts";

export type SeatKind = "disposable" | "guest";

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
  /** Guests bring their own signals or none; the floor writes nothing for them. */
  intentId: string | null;
  /** A negotiator key for a disposable seat. A guest's key is theirs and never reaches the floor. */
  apiKey: string | null;
}

export interface ProvisionedRun {
  runId: string;
  networkId: string;
  /** One per run, shared by every disposable seat. Shown in the lane so you can sign in as them. */
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
  onStep: (phase: string) => void,
): Promise<ProvisionedRun> {
  const runId = crypto.randomUUID().slice(0, 8);
  const password = `floor-${crypto.randomUUID()}`;

  const drivable = seats.filter((seat) => !seat.guestEmail);
  onStep(`seating ${drivable.length} people`);
  const registered = await Promise.all(
    seats.map((seat, position) =>
      seat.guestEmail ? null : register(seat, String(position + 1), runId, password),
    ),
  );

  onStep("opening a private network");
  const staff = new Index({ jwt: await operatorJwt() });
  const network = await staff.call<{ network: { id: string } }>("POST", "/api/networks", {
    title: `Floor ${runId}`,
    joinPolicy: "invite_only",
    metadata: { floorLab: true, runId },
  });
  const networkId = network.network.id;
  for (const person of registered) {
    if (!person) continue;
    await staff.call("POST", `/api/networks/${networkId}/members`, {
      userId: person.userId,
      permissions: ["member"],
    });
  }

  // Guests are invited rather than seated. Index resolves the address, gives
  // them an agent, and mails them a key scoped to this network — so the floor
  // learns who they are without ever holding a credential of theirs.
  const invited = new Map<string, Awaited<ReturnType<typeof invite>>>();
  const guestEmails = [...new Set(seats.map((seat) => seat.guestEmail).filter(Boolean) as string[])];
  if (guestEmails.length) {
    onStep(`inviting ${guestEmails.length} ${guestEmails.length === 1 ? "guest" : "guests"}`);
    for (const email of guestEmails) invited.set(email, await invite(staff, networkId, email));
  }

  // The signals go in together and discovery runs on each write. A write only
  // sees the peers already indexed, so this opens most pairs and the run's
  // reconciler opens whatever it missed.
  onStep(`admitting ${drivable.length} signals`);
  const intentIds = await Promise.all(
    registered.map(async (person) => {
      if (!person) return null;
      try {
        const created = await person.api.call<{ intentId: string }>("POST", "/api/intents", {
          description: person.intent,
          networkIds: [networkId],
        });
        return created.intentId;
      } catch (cause) {
        // Index turns away a signal it cannot act on, and says why. Name the
        // seat, or the person cannot tell which part of the run to rewrite.
        const why = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Index would not take ${person.name}'s signal. ${why}`);
      }
    }),
  );

  onStep("giving each seat a negotiator");
  const keys = await Promise.all(
    registered.map((person) => (person ? negotiatorKey(person.api, person.slot) : null)),
  );

  return {
    runId,
    networkId,
    password,
    seats: seats.map((seat, position) => {
      const slot = String(position + 1);
      const person = registered[position];
      if (person) {
        return {
          slot,
          kind: "disposable" as const,
          name: person.name,
          email: person.email,
          userId: person.userId,
          intentId: intentIds[position]!,
          apiKey: keys[position]!,
        };
      }

      const guest = invited.get(seat.guestEmail!)!;
      return {
        slot,
        kind: "guest" as const,
        name: guest.name,
        email: guest.email,
        userId: guest.userId,
        intentId: null,
        apiKey: null,
      };
    }),
  };
}

/**
 * Put someone on the guest list by address alone.
 *
 * Owner-only, and the operator owns every run's network, so this is the one
 * way to seat a real person without holding a credential of theirs. Index
 * resolves or creates the account, provisions them an agent and mails them a
 * key for this network; whether they turn up is then their business.
 */
async function invite(staff: Index, networkId: string, email: string) {
  if (!config.guests.includes(email)) throw new Error(`${email} is not one of this floor's people.`);

  try {
    const result = await staff.call<{ user: { id: string; email: string } }>(
      "POST",
      `/api/networks/${networkId}/members/invite`,
      { email },
    );
    return { userId: result.user.id, email: result.user.email, name: email.split("@")[0]! };
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Index would not invite ${email} to the run's network. ${why}`);
  }
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

  return { slot, name, email, userId, api, intent: seat.intent.trim() };
}

/**
 * An external agent holding this seat's negotiations, and the key it speaks
 * with. The key has to exist before the agent can be bound as the executor —
 * Index refuses to route negotiations to a runtime that cannot answer.
 */
async function negotiatorKey(api: Index, slot: string): Promise<string> {
  const created = await api.call<{ agent: { id: string } }>("POST", "/api/agents", {
    name: `Floor seat ${slot}`,
  });
  const token = await api.call<{ token: { key: string } }>("POST", `/api/agents/${created.agent.id}/tokens`, {
    name: "floor",
  });
  await api.call("PATCH", `/api/agents/${created.agent.id}`, { handleNegotiations: true });
  return token.token.key;
}
