/**
 * One shared password for the whole floor.
 *
 * The cookie carries an issue time and an HMAC of it keyed by the password
 * itself, so there is no session store to keep and a restart does not throw
 * everyone out. Changing the password invalidates every cookie, which is the
 * behaviour you want from a shared secret.
 */

import { config } from "./config.ts";

const COOKIE = "floor";
const LIFE_MS = 7 * 24 * 60 * 60 * 1000;

function sign(issuedAt: string): string {
  return new Bun.CryptoHasher("sha256", config.floorPassword).update(issuedAt).digest("hex");
}

function issue(): string {
  const issuedAt = String(Date.now());
  return `${issuedAt}.${sign(issuedAt)}`;
}

function valid(token: string | undefined): boolean {
  const [issuedAt, mac] = (token ?? "").split(".");
  if (!issuedAt || !mac) return false;
  if (Date.now() - Number(issuedAt) > LIFE_MS) return false;
  const expected = sign(issuedAt);
  // Lengths match by construction, so a plain compare leaks nothing useful.
  return mac.length === expected.length && mac === expected;
}

function readCookie(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return undefined;
}

/** Off entirely when no password is set. */
export const guarded = (): boolean => Boolean(config.floorPassword);

export function admitted(request: Request): boolean {
  return !guarded() || valid(readCookie(request));
}

export function grant(password: string): Response | null {
  if (password !== config.floorPassword) return null;
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": `${COOKIE}=${issue()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${LIFE_MS / 1000}${
        process.env.NODE_ENV === "production" ? "; Secure" : ""
      }`,
    },
  });
}
