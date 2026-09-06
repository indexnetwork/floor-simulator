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

Set `FLOOR_PASSWORD` and the whole floor sits behind one shared password, held
in a signed cookie. Leave it unset and the floor is open, which is what local
development wants. `/health` is always reachable, because Railway's healthcheck
has no cookie.

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

Each lane carries a `Credentials` disclosure holding that seat's email, its
password and its agent token, so you can sign in as the person the run invented
and carry on by hand.

## Auto answer

Index accepts `propose`, `counter`, `accept` and `decline`. It has no verb for
"wait, I need to ask my principal". So an agent that needs a figure nobody gave
it has two ways to go, chosen per seat at launch and switchable mid-run:

- **Auto answer on**, the default. The agent is never offered the ask verb. It
  decides from its brief and puts anything still open to the *other seat* inside
  its own message, so a run reaches an outcome unattended.
- **Auto answer off**. The question stops in the floor and appears in that
  seat's lane. Nothing moves until the person answers, and the answer becomes
  standing guidance for the rest of the run.

A model told not to ask occasionally asks anyway. It gets one more attempt, said
plainly, and if it insists the question reaches you regardless — better a run
that pauses than a turn nobody meant to send.

## Seating your own people

`FLOOR_GUESTS` lets a seat be a real account instead of a disposable one:

```
FLOOR_GUESTS=seref@index.network:idx_key_one,yanki@index.network:idx_key_two
```

An email alone will not do. Index has no impersonation — no admin plugin, no
staff override, no cross-user token mint — so each person mints an owner API key
from their own account and that is what the floor presents as them. Only the
emails ever reach the browser.

A guest seat is **watched, not driven**. The floor writes their signal into the
run's network and then keeps its hands off: their own agent answers, which is
the point of seating them. So there is no auto answer switch on that lane, no
question card, and no credentials disclosure — the floor holds none of their
secrets. If their agent is not running, the negotiation simply sits, and the
lane says so.

The signal the floor writes is a real row in that person's account and outlives
the run. It is confined to the run's invite-only network, but it is theirs.

## Deployment

Railway, single instance. Runs live in memory, so a restart drops whatever is
in flight — acceptable for a lab, and the reason `numReplicas` is pinned to 1.

`PORT` is injected by Railway. Everything else comes from `.env.example`.
