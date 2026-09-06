/**
 * Index Network as the floor reaches it: public REST, nothing privileged.
 *
 * Two credentials appear here. A seat JWT is what a person would hold, and it
 * is what registers agents and writes signals. An agent-bound API key is what
 * that seat's negotiator holds, and it is the only thing the negotiation loop
 * uses — JWTs expire in an hour and a run may outlive one.
 */

import { config } from "./config.ts";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type TurnAction = "propose" | "counter" | "accept" | "decline";

export interface Turn {
  turnIndex: number;
  seatUserId: string;
  action: TurnAction;
  message: string;
  createdAt: string;
}

export interface Negotiation {
  id: string;
  opportunityId: string;
  intentId: string;
  awaitingUserId: string | null;
  outcome: "agreed" | "declined" | "closed" | null;
  settledAt: string | null;
  turnCount: number;
  turns?: Turn[];
  counterparty: { userId: string; name: string | null; statement: string };
}

type Credential = { jwt?: string; key?: string };

export class Index {
  constructor(private readonly credential: Credential = {}) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${config.indexApiUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.credential.jwt ? { authorization: `Bearer ${this.credential.jwt}` } : {}),
        ...(this.credential.key ? { "x-api-key": this.credential.key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }

    if (!response.ok) {
      const shape = data as { error?: string; detail?: string };
      throw new ApiError(shape.detail ?? shape.error ?? `${method} ${path} failed`, response.status);
    }
    return data as T;
  }

  /** Who this credential belongs to. The only way to turn a guest's key into a user id. */
  async me(): Promise<{ id: string; email: string; name: string | null }> {
    const body = await this.call<{ user: { id: string; email: string; name: string | null } }>("GET", "/api/auth/me");
    return body.user;
  }

  listOpenNegotiations(): Promise<{ negotiations: Negotiation[] }> {
    return this.call("GET", "/api/negotiations?state=open");
  }

  async readNegotiation(opportunityId: string): Promise<Negotiation> {
    const body = await this.call<{ negotiation: Negotiation }>("GET", `/api/negotiations/${opportunityId}`);
    return body.negotiation;
  }

  async submitTurn(opportunityId: string, action: TurnAction, message: string): Promise<Negotiation> {
    const body = await this.call<{ negotiation: Negotiation }>(
      "POST",
      `/api/negotiations/${opportunityId}/turns`,
      { action, message },
    );
    return body.negotiation;
  }
}

const anonymous = new Index();

export async function signUp(email: string, password: string, name: string): Promise<{ userId: string; session: string }> {
  const body = await anonymous.call<{ token: string; user: { id: string } }>(
    "POST",
    "/api/auth/sign-up/email",
    { email, password, name },
  );
  return { userId: body.user.id, session: body.token };
}

export async function signIn(email: string, password: string): Promise<string> {
  const body = await anonymous.call<{ token: string }>("POST", "/api/auth/sign-in/email", { email, password });
  return body.token;
}

/** Trade a Better Auth session token for the JWT the API's guards read. */
export async function mintJwt(session: string): Promise<string> {
  const body = await new Index({ jwt: session }).call<{ token: string }>("GET", "/api/auth/token");
  return body.token;
}
