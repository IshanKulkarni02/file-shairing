# The LANShare relay

A small server that lets two machines behind home routers reach each other
without either one forwarding a port.

```bash
node relay/server.js --port 8460
```

One process. No database, no state on disk, nothing to back up. It runs
comfortably on the cheapest VPS or a free tier.

## Why anything in the middle is needed

Two machines behind NAT cannot introduce themselves to each other: neither has
an address the other can dial, and nothing arrives at either without port
forwarding. Something with a public address has to be in the middle. That is
not a design choice — it is how NAT works. The only real question is how small
and how trusted that middle thing has to be.

## What it can and cannot see

It accepts two outbound connections naming the same room, copies bytes between
them, and understands nothing else.

Every frame is sealed with AES-256-GCM under a key both peers derive from the
pairing code, which is exchanged out of band and never sent here. So a relay
operator — including a hostile one who has taken the machine — **can**:

- see that two peers are talking, and roughly how much
- cut the connection off

and **cannot**:

- read a password, a photo, a filename, or even which URL was requested
- alter anything in flight (a single flipped bit fails authentication)
- replay an earlier frame (each carries a counter that must arrive in order)
- reuse a frame in the other direction (each direction has its own key)

Because it holds nothing worth stealing, running someone else's relay is a
much smaller decision than it sounds — and running your own removes even the
metadata.

## What it deliberately does not do

**No TLS of its own.** The payload is already end-to-end encrypted, so a
certificate here would add operational pain — renewals, a domain name — for no
security gain.

**No accounts.** There is nothing to protect: a room id is derived from a
pairing code the relay never sees, so knowing one gets you an encrypted stream
you cannot read.

**No NAT hole punching.** Punching would let peers talk directly and drop the
relay out of the path, which is faster. It also needs a WebRTC stack, fails
outright on symmetric NAT, and requires a relay as the fallback anyway.
Building the fallback first means the feature works everywhere; direct
connections can be added later without changing the protocol above this line.

## Limits

- 500 rooms at once
- 16 MB per frame
- a peer waiting alone in a room is dropped after two minutes
- a second peer claiming an occupied role is refused, and refusing it never
  disturbs the pair already there
