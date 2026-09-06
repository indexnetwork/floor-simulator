export const config = {
  indexApiUrl: (process.env.INDEX_API_URL ?? "https://protocol.dev.index.network").replace(/\/$/, ""),
  operatorEmail: process.env.FLOOR_OPERATOR_EMAIL ?? "",
  operatorPassword: process.env.FLOOR_OPERATOR_PASSWORD ?? "",
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
