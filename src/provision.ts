/**
 * One run's worth of Index: two disposable people, a private network only
 * they are in, a signal each, and a negotiator agent each.
 *
 * Everything here is a public call any account could make. The old floor lab
 * wrote these rows directly because it ran inside the API; from outside, the
 * one thing a fresh account cannot do is create a network, so the floor signs
 * in as a staff operator for that step and nothing else.
 */

import { config } from "./config.ts";
import { Index, mintJwt, signIn, signUp } from "./index-api.ts";

export interface SeatInput {
  name: string;
  intent: string;
  profile?: string;
  location?: string;
  /** Carried through to the seat's negotiator; nothing here provisions it. */
  mayAsk?: boolean;
}

export interface ProvisionedSeat {
  slot: "a" | "b";
  name: string;
  email: string;
  userId: string;
  intentId: string;
  apiKey: string;
}

export interface ProvisionedRun {
  runId: string;
  networkId: string;
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

  onStep("registering two people");
  const registered = await Promise.all(
    seats.map((seat, position) => register(seat, position === 0 ? "a" : "b", runId, password)),
  );

  onStep("opening a private network");
  const staff = new Index({ jwt: await operatorJwt() });
  const network = await staff.call<{ network: { id: string } }>("POST", "/api/networks", {
    title: `Floor ${runId}`,
    joinPolicy: "invite_only",
    metadata: { floorLab: true, runId },
  });
  for (const person of registered) {
    await staff.call("POST", `/api/networks/${network.network.id}/members`, {
      userId: person.userId,
      permissions: ["member"],
    });
  }

  // Both signals go in together: discovery runs on each write, and the one
  // that lands second is what seats the pair.
  onStep("admitting both signals");
  const intentIds = await Promise.all(
    registered.map(async (person) => {
      try {
        const created = await person.api.call<{ intentId: string }>("POST", "/api/intents", {
          description: person.intent,
          networkIds: [network.network.id],
        });
        return created.intentId;
      } catch (cause) {
        // Index turns away a signal it cannot act on, and says why. Name the
        // seat, or the person cannot tell which half of the run to rewrite.
        const why = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Index would not take ${person.name}'s signal. ${why}`);
      }
    }),
  );

  onStep("giving each side a negotiator");
  const apiKeys = await Promise.all(registered.map((person) => negotiatorKey(person.api, person.slot)));

  return {
    runId,
    networkId: network.network.id,
    seats: registered.map((person, position) => ({
      slot: person.slot,
      name: person.name,
      email: person.email,
      userId: person.userId,
      intentId: intentIds[position]!,
      apiKey: apiKeys[position]!,
    })),
  };
}

async function register(seat: SeatInput, slot: "a" | "b", runId: string, password: string) {
  const email = `floor+${runId}+${slot}@${config.seatEmailDomain}`;
  const name = seat.name.trim() || `Player ${slot.toUpperCase()}`;
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
async function negotiatorKey(api: Index, slot: "a" | "b"): Promise<string> {
  const created = await api.call<{ agent: { id: string } }>("POST", "/api/agents", {
    name: `Floor seat ${slot}`,
  });
  const token = await api.call<{ token: { key: string } }>("POST", `/api/agents/${created.agent.id}/tokens`, {
    name: "floor",
  });
  await api.call("PATCH", `/api/agents/${created.agent.id}`, { handleNegotiations: true });
  return token.token.key;
}
