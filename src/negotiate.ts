/**
 * One seat's next move.
 *
 * The verbs are the platform's: propose, counter, accept, decline. Asking the
 * principal is not among them — Index has no hold verb — so a question is
 * never submitted. It goes to the person playing that seat and the
 * negotiation simply stays where it is until they answer.
 *
 * A seat can also be run with nobody to ask, which is a different brief rather
 * than a filter on the same one: an agent that knows no answer is coming
 * argues from what it has instead of reaching for a question it cannot send.
 */

import { askModel } from "./model.ts";
import type { Negotiation, TurnAction } from "./index-api.ts";

export type Decision =
  | { action: TurnAction; message: string }
  | { action: "ask"; question: string };

interface Answer {
  action?: string;
  message?: string;
  question?: string;
}

const OPENING = `You are the negotiating agent for one seat in a two-party negotiation on Index Network.

Submit exactly one structured decision. The verbs the platform accepts are:

- "propose"  the opening turn only, when nothing has been said yet
- "counter"  continue the exchange with a position of your own
- "accept"   bind to the other seat's standing offer (a recommendation; the humans still consent on Index)
- "decline"  end without a deal`;

const CLOSING = `Answer with a JSON object:
{"action": "...", "message": "...", "question": "..."}

- "message" is required for propose, counter, accept and decline. The other seat reads it.`;

const RULES = `${OPENING}
- "ask"      stop and ask the party you act for something only they can answer. This is local: it is not submitted.

Choose "ask" rather than inventing any figure, date or commitment your brief and your principal's guidance do not already cover. Choose "accept" or "decline" when the terms on the table are clear enough. Keep messages to a few sentences.

${CLOSING}
- "question" is required for ask.`;

/**
 * The same brief with nobody to ask. The seat's principal is unavailable, so
 * the agent works from what it has: it may hold a position, press for the
 * detail it wants in its own message, or decline — but it cannot stop.
 */
const RULES_WITHOUT_ASKING = `${OPENING}

There is nobody to ask. Decide from your brief, your principal's guidance and the exchange so far. Do not commit to a figure, date or obligation none of those cover — put the open question to the other seat inside your own message instead, or decline if the terms cannot be reached without it. Choose "accept" or "decline" when the terms on the table are clear enough. Keep messages to a few sentences.

${CLOSING}`;

export async function decide(
  negotiation: Negotiation,
  userId: string,
  ownStatement: string,
  guidance: string[],
  mayAsk = true,
): Promise<Decision> {
  const turns = negotiation.turns ?? [];
  const transcript = turns.length
    ? turns
        .map((turn) => `[${turn.turnIndex}] ${turn.seatUserId === userId ? "us" : "them"} (${turn.action}): ${turn.message}`)
        .join("\n")
    : "Nothing has been said yet. This is the opening turn — use propose, or decline if the match is not worth pursuing.";

  const brief = [
    `You are acting for someone looking for: ${ownStatement}`,
    negotiation.counterparty.statement.trim()
      ? `The other party is looking for: ${negotiation.counterparty.statement.trim()}`
      : "You were given no statement for the other party. Ask your principal rather than inventing terms.",
    ...(guidance.length
      ? [`Guidance from the party you act for:\n${guidance.map((line) => `- ${line}`).join("\n")}`]
      : []),
  ].join("\n\n");

  const prompt = [`Your brief:\n${brief}`, `The exchange so far:\n${transcript}`, "Decide your next turn."].join("\n\n");
  const rules = mayAsk ? RULES : RULES_WITHOUT_ASKING;

  let answer = await askModel<Answer>([
    { role: "system", content: rules },
    { role: "user", content: prompt },
  ]);

  // A model told not to ask sometimes asks anyway. One more attempt, said
  // plainly; if it insists, the question is real and goes to the person —
  // better a run that pauses than a turn nobody meant to send.
  if (!mayAsk && answer.action === "ask") {
    answer = await askModel<Answer>([
      { role: "system", content: rules },
      { role: "user", content: prompt },
      {
        role: "user",
        content: `You answered with "ask", which is not one of the verbs. Nobody is available to answer it. Choose propose, counter, accept or decline now.`,
      },
    ]);
  }

  switch (answer.action) {
    case "propose":
    case "counter":
    case "accept":
    case "decline":
      if (!answer.message) throw new Error(`"${answer.action}" needs a message.`);
      return { action: answer.action, message: answer.message };
    case "ask":
      if (!answer.question) throw new Error('"ask" needs a question.');
      return { action: "ask", question: answer.question };
    default:
      throw new Error(`The model chose an action that does not exist: "${answer.action ?? "none"}".`);
  }
}
