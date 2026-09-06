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
  /** Guests bring their own signals or none; the floor writes nothing for them. */
  intentId: string | null;
  /** A negotiator key for an ephemeral seat. A guest's key is theirs and never reaches the floor. */
  apiKey: string | null;
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

  // Guests join the same way anyone does: look the address up, add the member.
  // The floor holds no credential of theirs and creates nothing on their behalf.
  const guests = new Map<string, { userId: string; email: string; name: string }>();
  const guestEmails = [...new Set(seats.map((seat) => seat.guestEmail).filter(Boolean) as string[])];
  if (guestEmails.length) {
    onStep(`adding ${guestEmails.length} ${guestEmails.length === 1 ? "person" : "people"}`);
    for (const person of await lookUp(staff, guestEmails)) {
      guests.set(person.email, person);
      await staff.call("POST", `/api/networks/${networkId}/members`, {
        userId: person.userId,
        permissions: ["member"],
      });
    }
    const unknown = guestEmails.filter((email) => !guests.has(email));
    if (unknown.length) throw new Error(`No Index account for ${unknown.join(", ")}.`);
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
          kind: "ephemeral" as const,
          name: person.name,
          email: person.email,
          userId: person.userId,
          intentId: intentIds[position]!,
          apiKey: keys[position]!,
        };
      }

      const guest = guests.get(seat.guestEmail!)!;
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
 * Turn the guest list's addresses into Index accounts.
 *
 * Staff-only on Index's side, which the operator is. It resolves existing
 * accounts and nothing else — an address with no account comes back absent
 * rather than provisioned, so a typo in the env fails the run instead of
 * quietly making an empty user.
 */
async function lookUp(staff: Index, emails: string[]) {
  const strangers = emails.filter((email) => !config.guests.includes(email));
  if (strangers.length) throw new Error(`${strangers.join(", ")} is not one of this floor's people.`);

  try {
    const found = await staff.call<{ users: { id: string; email: string; name: string }[] }>(
      "POST",
      "/api/users/lookup",
      { emails },
    );
    return found.users.map((user) => ({
      userId: user.id,
      email: user.email,
      name: user.name?.trim() || user.email.split("@")[0]!,
    }));
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Index would not resolve this floor's people. ${why}`);
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
