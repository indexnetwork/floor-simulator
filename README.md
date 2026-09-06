# the floor

Two people, one screen. Every run registers two real Index accounts, puts them
in a private network of their own, and lets their agents negotiate for real —
while you sit in both seats and answer the questions the agents cannot.

Nothing here is simulated. The users, the network, the signals, the discovery
that pairs them and the negotiation they settle all happen on Index. The floor
is only the orchestrator: it holds no database of its own and never writes to
Index's.

## Running it

Needs [Bun](https://bun.sh) and an Index to talk to.

```bash
cp .env.example .env   # fill in the operator password and OpenRouter key
bun install
bun run dev
```

`FLOOR_OPERATOR_*` is a staff account on the target Index — any address at
`@index.network`. It is used for exactly one thing: creating each run's
network, which is staff-only. Everything else a run does, it does as the two
disposable people it just registered.

Email/password sign-up has to be enabled on the target Index. Check with:

```bash
curl https://protocol.dev.index.network/api/auth/providers   # emailPassword: true
```

## What a run does

| Step | Called as |
|------|-----------|
| Register two people, mint their JWTs | anonymous → each seat |
| Open an invite-only network, add both | operator |
| Write a signal each | each seat |
| Register a negotiator agent, mint its key, bind it | each seat |
| Discover, propose, counter, settle | each agent's API key |

Discovery is scoped to the run's two-person network, so each seat is the
other's only candidate.

## The one thing that is not a negotiation verb

Index accepts `propose`, `counter`, `accept` and `decline`. It has no verb for
"wait, I need to ask my principal". So when an agent needs a figure or a date
nobody has given it, the question stops in the floor and appears in that seat's
lane. The negotiation does not move until the person answers, and the answer
becomes standing guidance for the rest of the run.

## Deployment

Railway, single instance. Runs live in memory, so a restart drops whatever is
in flight — acceptable for a lab, and the reason `numReplicas` is pinned to 1.

`PORT` is injected by Railway. Everything else comes from `.env.example`.
