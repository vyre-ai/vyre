# DigitalOcean Marketplace listing: Vyre (draft, not submitted)

Fields for the Vendor Portal. Written in the website's voice. Nothing here is submitted until the user says go.

## Name

Vyre

## Tagline (one line)

Your Claude Code agents, on a server you own.

## Summary (short description)

Vyre is an open-source home for Claude Code agents. They run on this Droplet, keep working when your laptop is closed, and answer when you press Option-Space on your Mac or open Vyre on your phone.

## Description

Your agents live on your server. Reach them from your Mac or your phone.

Vyre is an open-source, self-hosted home for Claude Code agents. This image gives you a Droplet that sets itself up: the first time it boots, it installs the latest Vyre release, after checking the release's signature, and starts it. Nothing else to install.

What you get:

- Agents that keep working when your laptop is closed, and answer when you press Option-Space on your Mac or open Vyre on your phone.
- An encrypted vault on the Droplet for your API keys. Anything that sends a message, posts or pays waits for your Touch ID or Face ID.
- Your sessions, memory and projects stay on this Droplet.
- A private address on Vyre's own built-in network. The Droplet opens no port to the internet except SSH.

What you need besides the Droplet: a Claude subscription or an Anthropic API key, and a Mac or an iPhone or Android phone.

Vyre is open source (Apache 2.0): https://github.com/vyre-ai/vyre

## Software included

- Vyre, the latest release, installed at first boot and verified against the Vyre release signing key built into the image
- Docker Engine and Docker Compose, from Docker's own apt repository
- Ubuntu 24.04 LTS, with ufw on (SSH only) and unattended security updates

## Operating system

Ubuntu 24.04 LTS (x64)

## Recommended Droplet size

2 GB of memory or more. (Vyre's own process is small; each Claude Code session adds about 190 MB before it has done any work.)

## Getting started

1. Create the Droplet. Add your SSH key.
2. Log in with SSH. A banner says whether Vyre has finished installing (about a minute after first boot).
3. Run `sudo vyre call wink.server.code '{"qr":true}'`. It shows a QR and a long code.
4. Open the Vyre app, scan the QR or paste the long code, and confirm the three words. The app then walks you through connecting your Claude account.

To update Vyre later: `vyre update`. It checks the same signature before it changes anything.

## Support

Vyre, not DigitalOcean, provides support for this software.

- Documentation: https://github.com/vyre-ai/vyre/tree/main/docs
- Questions and bugs: https://github.com/vyre-ai/vyre/issues

DigitalOcean does not build or support Vyre.

## Pricing

Free. You pay only for the Droplet.

## Facts to keep true (check before every submission)

- The Vyre app pairs this server with the code `sudo vyre call wink.server.code` shows; check the command and the app's pairing screens say this before any submission.
- The image installs the latest release at first boot; it does not bake one in. The first-boot script is packaging/digitalocean/files/vyre-firstboot.
- "Nothing opens to the internet except SSH" holds while the firewall in 010-base.sh is unchanged and Vyre binds 127.0.0.1 (box/compose.yml). Re-check both.
- The 2 GB recommendation is a floor from measurements of Vyre's process and idle sessions, not of a loaded Droplet. Re-measure on a real 2 GB Droplet before the listing goes live.
- The listing must say DigitalOcean does not build or support the software, name the company "DigitalOcean", and not claim it endorses Vyre (vendor terms).
