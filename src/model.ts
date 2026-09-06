/**
 * The model the agents think with, over OpenRouter. Retries live here and
 * nowhere else, so the two seat loops never stack backoff on top of it.
 */

import { config } from "./config.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
const ATTEMPTS = 3;

export interface Message {
  role: "system" | "user";
  content: string;
}

export async function askModel<T>(messages: Message[]): Promise<T> {
  let lastReason = "";

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openRouterKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const body = await response.text();
      if (!RETRYABLE.has(response.status) || attempt === ATTEMPTS) {
        throw new Error(`OpenRouter ${response.status}: ${body.slice(0, 200)}`);
      }
      lastReason = `HTTP ${response.status}`;
      await backoff(attempt, response.headers.get("retry-after"));
      continue;
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`OpenRouter returned no message: ${body.error?.message ?? "empty response"}`);
    }

    try {
      return JSON.parse(stripFence(content)) as T;
    } catch {
      throw new Error(`The model answered with something that isn't JSON: ${content.slice(0, 200)}`);
    }
  }

  throw new Error(`The model did not answer after ${ATTEMPTS} attempts (${lastReason}).`);
}

function backoff(attempt: number, retryAfter: string | null): Promise<void> {
  const asked = retryAfter ? Number(retryAfter) * 1000 : NaN;
  const wait = Number.isFinite(asked) ? asked : 2 ** (attempt - 1) * 1000;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

/** Models fence JSON in markdown often enough to be worth handling. */
function stripFence(text: string): string {
  return text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)?.[1] ?? text;
}
