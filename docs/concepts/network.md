---
title: Your private network
summary: How your devices and servers find each other with nothing to install, how a device pairs, whether a connection is direct or through the relay, what your address is, and who is on the other end.
audience: users, builders, operators
owner: network
status: stable
---

# Your private network

Your devices and your server reach each other through a private network that is built into Vyre. There is nothing to install and nothing to sign in to: you see Wink, the pairing and the cards that go with it, and Vyre does the rest. The same network tells your server who is on the other end of a connection, which is why there is no login screen.

## Direct or through the relay

The relay is always the first working path and the fallback. Your server is reachable through it from the first second, and nothing later takes it away. In the background your server also tries to make a direct path, in this order:

1. **IPv6.** A global address on the machine is reported as a candidate. Your own firewall decides whether the port is open.
2. **UPnP.** Your router is asked to forward a port to the machine, with a lease that is renewed and deleted on stop.
3. **NAT-PMP.** The same ask in the router's other language.

Nothing is exposed that your router did not agree to, and no rule is made on the machine. A path is called direct only after it was reached from outside: the relay dials the address back. Without that proof the state stays "relay", and Vyre says why. A router that reports a private or carrier-grade external address is not directly reachable, and Vyre says so.

When a device opens a connection to a space's home, the direct dial starts first. If it is not up within three seconds, the relay stream starts too. The first answer carries the calls, direct is preferred as soon as it is up, and the relay stream closes when it is no longer the way in. A dead direct path is retried at most once a minute while the relay carries the work. The relay carries end-to-end encrypted traffic and cannot read it (see [the relay](../adr/0026-relay.md)).

`vyre doctor` shows **Path to your server**, **Relay**, **Server door** and **Clock**, and each says what failed and the one thing to do next.

## Pairing a device

Every way into a space is a Wink: a code or a scan on one device, a card on the other, and then exactly one grant. There is no hidden way in.

- **A phone.** Your server or a computer you are signed in on shows a QR code and a long code. The phone scans or pastes it, both screens show the same three words, and you say yes on the computer. No yes pairs nothing.
- **A Mac.** `vyre up` asks for your server's pairing code, shows three words, and pairs once you confirm they match on both screens and approve with your passkey.
- **A person.** An invite is a Wink ticket with the offer sealed into it. The invited person's redemption becomes a membership in your space, and a sensitive role waits for an admin's approval.
- **A computer you lend.** You lend one of your computers to a space with limits, and one removal undoes all of it.

You can see every grant as a card with its last use, and one removal does all of it.

## Your address

Your server is served at one HTTPS address:

| Address | When | Certificate |
|---|---|---|
| `https://alex.vyre.run` | the default after setup at vyre.run/setup: a name you claim there | Let's Encrypt, by DNS challenge |
| your own domain, such as `https://vyre.harlowlegal.example` | when you bring a domain at the end of setup | Let's Encrypt, by DNS challenge through a record you add |

A `vyre.run` name is an A record pointing at your server's address on the private network (a `100.64.x.x` address). It resolves on the public internet, but nothing off your network can reach it. The name is claimed through Vyre's hosted name directory. For your own domain, you add two records, an A record to the server's address on the private network and an `_acme-challenge` CNAME, and Vyre checks the CNAME before it serves the domain.

```
vyre name                 # this box's address and its phase
vyre name check alex      # is alex.vyre.run free?
vyre name claim alex
vyre name release
```

## Identity: who is calling

A device that reaches your server arrives at its door as `device:<id>`. Who that is comes from the entry on your identity list and from the sessions the door admitted, never from anything a peer could set itself, such as a tag or host information. Every call on a direct or relay session reads the entry again first, so a removed device is refused at once.

That caller is a device of yours, not yet you. Tools that act as you, and the ones that need a person present, also need a person session, made by signing in with a passkey on that device (see [presence](presence.md)).

## The owner

A space has owners, and a role decides what each person may do: owner, admin, manager, member and temp. An owner may assign every role. An admin may manage members and roles below admin, and devices, never owners or admins. Managers, members and temp manage no members. Your own space has you as its owner.

## Device identity is not presence

`device:<id>` proves which device sent a request. It does not prove that you are at that device: Claude Code on your Mac is on the same network as the same identity. So a device caller gets no pass on tools that need a person. Your phone or computer proves [presence](presence.md) with a passkey like every other surface.

## What it will not do

- No passwords, no login screen, no sessions on the network address.
- vyred itself opens no listener on the network. Connections arrive through the relay and through the built-in network's own gate.
- If you run another VPN of your own on a machine, Vyre does not use it and does not ask for it. Vyre's connection to a space then stays on the relay.
- Root on the server, and anyone who can reach its Docker socket, are out of scope.

## Next

- [The box and the Mac](box-and-mac.md): how the Mac reaches the box.
- [Presence](presence.md): proving a person is there.
