export interface Guest {
  email: string;
  apiKey: string;
}

/**
 * People you can seat instead of a fresh ephemeral one, as `email:apiKey`
 * pairs, comma separated.
 *
 * The key is an owner key for that account and acts as them everywhere, not
 * only on this floor — it is what lets the floor write their signal and read
 * their side of a negotiation. The address beside it is only a label, and
 * provisioning checks it against the account the key actually opens.
 */
function parseGuests(raw: string): Guest[] {
  return raw.split(",").flatMap((entry) => {
    const at = entry.indexOf(":");
    if (at < 0) return [];
    const email = entry.slice(0, at).trim().toLowerCase();
    const apiKey = entry.slice(at + 1).trim();
    return email && apiKey ? [{ email, apiKey }] : [];
  });
}

export const config = {
  indexApiUrl: (process.env.INDEX_API_URL ?? "https://protocol.dev.index.network").replace(/\/$/, ""),
  operatorEmail: process.env.FLOOR_OPERATOR_EMAIL ?? "",
  operatorPassword: process.env.FLOOR_OPERATOR_PASSWORD ?? "",
  /** Unset leaves the floor open, which is what local development wants. */
  floorPassword: process.env.FLOOR_PASSWORD ?? "",
  guests: parseGuests(process.env.FLOOR_GUESTS ?? ""),
  seatEmailDomain: process.env.FLOOR_SEAT_EMAIL_DOMAIN ?? "floor.index.network",
  openRouterKey: process.env.OPENROUTER_API_KEY ?? "",
  model: process.env.MODEL ?? "google/gemini-3.7-flash",
  port: Number(process.env.PORT ?? 3000),
  maxTurns: Number(process.env.FLOOR_MAX_TURNS ?? 10),
  pollMs: Number(process.env.FLOOR_POLL_MS ?? 3000),
};

/** Refuse to start without the three credentials every run needs. */
export function assertConfigured(): void {
  const missing = [
    ["FLOOR_OPERATOR_EMAIL", config.operatorEmail],
    ["FLOOR_OPERATOR_PASSWORD", config.operatorPassword],
    ["OPENROUTER_API_KEY", config.openRouterKey],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")}. See .env.example.`);
  }
}
