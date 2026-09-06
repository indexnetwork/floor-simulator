# the floor

A room of people, one screen. Every run registers real Index accounts, puts them
in a private network of their own, and lets their agents negotiate for real —
while you sit in every seat and answer the questions the agents cannot.

Nothing here is simulated. The users, the network, the signals, the discovery
that pairs them and the negotiations they settle all happen on Index. The floor
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
network, which is staff-only. Everything else a run does, it does as the
ephemeral people it just registered.

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
| Register the players, mint their JWTs | anonymous → each seat |
| Open an invite-only network, add everyone | operator |
| Write a signal each | each seat |
| Register a negotiator agent, mint its key, bind it | each seat |
| Discover, propose, counter, settle | each agent's API key |

Discovery is scoped to the run's own network, so the players are each other's
only candidates.

Each lane carries a `Credentials` disclosure holding that seat's email, its
password and its agent token, so you can sign in as the person the run invented
and carry on by hand. Every ephemeral seat in a run shares one password.

## More than two players

Index negotiations are strictly bilateral, but a person can hold as many at once
as they have counterparts. So a floor of four is up to six negotiations, and a
floor of six is fifteen — each lane stacks everything that seat is in the middle
of, blocked-on-you first.

Two things follow from the shape:

- **Discovery only sees the signals already indexed.** The signals of a run go
  in together, so a first wave can leave a pair unopened. A minute in, the run
  compares the pairs it has against the pairs it should have and pauses and
  resumes the signals behind any hole, which runs their discovery again against
  a fully indexed network. Index's pair key stops it duplicating what is open.
- **Polling scales with the board.** The interval grows with the number of
  negotiations, so the request rate against Index stays roughly flat whether you
  seat two people or ten.

Not every pair produces a negotiation, and that is Index working: two founders
both raising will usually not be matched, and when they are, one of them
declines in a turn.

## The two switches

Every seat the floor drives has two, set at launch and switchable mid-run.

**Enable negotiations** is the floor's own loop. Off, the seat is still seated,
still discoverable and still a counterpart — the floor just never writes a turn
for it. Anything already in flight lands; nothing new starts. Its counterparts
carry on with each other, and their negotiations with it say whose agent is off.

**Ask questions** is nested under it, and only means something while the loop is
running. Index accepts `propose`, `counter`, `accept` and `decline` and has no
verb for "wait, I need to ask my principal", so an agent that needs a figure
nobody gave it has two ways to go:

- **Off**, the default. The agent is never offered the ask verb. It decides from
  its brief and puts anything still open to its counterpart inside its own
  message, so a run reaches an outcome unattended.
- **On**. The question stops in the floor and appears on the negotiation that
  raised it. That one negotiation waits; the seat's others carry on. Switching
  it back off retracts anything still on screen, since nobody is going to answer.

An answer unblocks the negotiation that asked and then joins that seat's
standing brief — a ceiling or a date is a fact about the person, not about one
deal, so every counterpart they are talking to gets it too.

A model told not to ask occasionally asks anyway. It gets one more attempt, said
plainly, and if it insists the question reaches you regardless — better a run
that pauses than a turn nobody meant to send.

## Inviting real people

`FLOOR_GUESTS` is a guest list. Emails, comma separated, and nothing else:

```
FLOOR_GUESTS=seref@index.network,yanki@index.network,seren@index.network
```

They show up as a dropdown on every player card. Picking someone takes them out
of the other cards' dropdowns, since one account cannot hold two seats in one
network.

The floor holds no credential of theirs and cannot act as them. It invites them
as the owner of the run's network, and Index does the rest: it resolves the
address to an existing account, adds them as a member, provisions them a
network-scoped agent and mails them the key. From there the seat is **watched,
not driven** — no switches on that lane, no question card, no credentials
disclosure, and no signal written on their behalf. Their lane stays empty until
they bring a signal to the network and their own agent answers.

Two consequences worth knowing:

- **A run mails every guest.** Each run opens a fresh network, so each run
  provisions a fresh scoped agent and sends a fresh invite email. Inviting the
  same three people all afternoon means three emails per run.
- **An address with no account gets one.** Index creates the user so it has
  somewhere to send the key. Invite an address nobody owns and you have made an
  empty account.

Because the floor learns of a guest's negotiations by finding them as the
counterpart on a seat it *does* hold a key for, two guests talking only to each
other stay invisible to the screen. Their negotiation is real; the floor just
cannot see it.

## Deployment

Railway, single instance. Runs live in memory, so a restart drops whatever is
in flight — acceptable for a lab, and the reason `numReplicas` is pinned to 1.

`PORT` is injected by Railway. Everything else comes from `.env.example`.
