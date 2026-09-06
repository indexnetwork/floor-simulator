# the floor

A room of people, one screen. Every run registers real Index accounts, puts them
in a private network of their own, and lets their agents negotiate for real —
while you sit in every seat and answer the questions the agents cannot.

Nothing here is simulated. The users, the network, the signals and the
negotiations they settle all happen on Index. The floor is only the
orchestrator: it holds no database of its own and never writes to Index's.

One thing it does not leave to Index is who talks to whom. Discovery decides
whether a pair is worth pairing, which is the right question for Index and the
wrong one for a simulator — you asked for these people to negotiate, so the
floor opens the negotiations itself.

## Running it

Needs [Bun](https://bun.sh) and an Index to talk to.

```bash
cp .env.example .env   # fill in the operator password and OpenRouter key
bun install
bun run dev
```

`FLOOR_OPERATOR_*` is a staff account on the target Index — any address at
`@index.network`. It is used for two things, both staff-only: creating each
run's network, and opening the negotiations in it. Everything else a run does,
it does as the people sitting on the floor.

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
| Register the ephemeral players, mint their JWTs | anonymous → each seat |
| Open an invite-only network, add everyone | operator |
| Write a signal each | each seat, guests included |
| Register a negotiator agent, mint its key, bind it | each ephemeral seat |
| Open a negotiation from the primary to each other seat | operator |
| Propose, counter, settle | each agent's API key |

Each lane carries a `Credentials` disclosure holding that seat's email, its
password and its agent token, so you can sign in as the person the run invented
and carry on by hand. Every ephemeral seat in a run shares one password.

## The primary, and more than two players

Index negotiations are strictly bilateral, but a person can hold as many at once
as they have counterparts. So a floor of four is up to six negotiations — each
lane stacks everything that seat is in the middle of, blocked-on-you first.

One seat is the **primary**, picked with a radio on the setup cards and
defaulting to the first. The floor opens a negotiation from them to every other
seat, so a floor of four starts with three. Naming them as the initiator is
Index's way of saying who owes the opening turn, so putting the primary on a
real person means *their* agent moves first, and putting it on an ephemeral
player means the floor does.

Two things follow:

- **Discovery still runs, and cannot be switched off.** It fires on every signal
  write and may open further pairs the floor never asked for, between two
  non-primary seats. Those are real negotiations and the floor drives them like
  any other. Where it reaches a pair the floor also asked for, Index's pair key
  makes whichever arrives second a no-op.
- **Polling scales with the board.** The interval grows with the number of
  negotiations, so the request rate against Index stays roughly flat whether you
  seat two people or ten.

Nothing checks compatibility any more, so a pair can be nonsense — two founders
both raising will open a negotiation and one of them will decline in a turn.
That is the trade for a floor that always has something on it.

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

## Seating real people

`FLOOR_GUESTS` is a guest list of `email:apiKey` pairs, comma separated:

```
FLOOR_GUESTS=seref@index.network:idx_...,yanki@index.network:idx_...
```

Mint a key from a signed-in session — it is session-only, so an existing key
cannot mint the next one:

```bash
curl -X POST https://protocol.dev.index.network/api/auth/cli-credential \
  -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"protocolVersion":2}'   # good for 90 days
```

An agent key is not this. It resolves to you, so `/auth/me` cannot tell the two
apart, but an agent is pinned to the networks it was scoped to and cannot write
into the one a run just made — the floor checks and refuses one before it
creates anything.

**An account key acts as you everywhere, not only on this floor.** It is what
lets the floor write your signal into your account and read your side of a
negotiation.
The address beside it is only a label, and provisioning checks the two against
each other with `GET /auth/me`: a mispaired entry fails the run rather than
quietly writing into somebody else's account.

Guests show up as a dropdown on every player card. Picking someone takes them
out of the other cards' dropdowns, since one account cannot hold two seats in
one network. A guest card keeps the signal box — the floor writes that signal as
them — and drops the name, profile and switches, which belong to their real
account.

From there the seat is **watched, not driven**. The floor reads their lane
through their key and shows every turn, but never authors one: their own agent
owes each of them. So a guest lane with a connected agent moves on its own, and
a guest lane without one opens and then sits, shown as waiting on them. There is
no credentials disclosure on a guest lane; that key came from you.

Everything a guest does here is real and lands in their actual Index account —
the network membership, the signal, the negotiation and any notification about
it.

## Deployment

Railway, single instance. Runs live in memory, so a restart drops whatever is
in flight — acceptable for a lab, and the reason `numReplicas` is pinned to 1.

`PORT` is injected by Railway. Everything else comes from `.env.example`.
