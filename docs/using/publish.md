---
title: Publish
summary: How a folder of ready files becomes a site on the internet with one yes, where its keys come from, how it gets a GitHub repo, and what this server cannot build yet.
audience: users, agents
owner: docs
status: draft
---

# Publish

Publish puts a site on the internet from your own server. Nothing goes public without a person's yes, and a model can start the work and ask but never decide.

## A folder of ready files, one yes

Give Publish a folder of ready files (a site that needs no build: HTML, CSS, images) and it builds a private preview, then asks you once. Your yes approves the preview and puts it live in the same step, because the plan you say yes to is the public one: the address, the version it replaces, the files' fingerprint and the keys it uses.

A files preview's card has a Publish button: it sends the preview's id (`publish.quick { name, preview }`), never a path, and the server finds the folder itself. A preview of a running server or of one file is refused in words. From the terminal: `vyre call publish.quick '{"name":"bakery","folder":"/path/to/site"}'`. It answers with the preview and a request; `vyre call publish.decide '{"task":"...","approve":true}'` is the yes. A site with the same name replaces the live one, which is kept so you can go back with `publish.rollback`.

Files that look like secrets (an `.env`, a private key), `.git` and `node_modules` are left out and named in the build log, links are never followed, and a folder over 2,000 files or 50 MB is refused. Naming a folder on the server is your act: a model asks you to publish it (from the preview card or the terminal) and never names one itself. A file that holds a key (a GitHub token, an AWS key, a private key) stops the build with the file's name. The plan you say yes to lists how many files go public, how large they are and the first names.

Making it live takes several steps if you want them separately: `publish.create`, `publish.preview`, `publish.approve` and `publish.publish` each hold for your decision. `publish.go` is the shortcut for a version that is already previewed.

## Keys

A site gets the keys it needs from the [Vault](vault.md), one at a time, and only the ones you give it. See "Keys for a published site" there.

## A GitHub repo for the folder

With a GitHub account connected (see [Connectors](connectors.md)), ask for a new repo for the folder: it is made under your account or an organisation you belong to, private unless you say public, and the folder goes there as the first commit.

## A React page

A folder with a React page (`index.jsx`, `index.tsx`, `App.jsx` or `App.tsx`, and no `index.html`) publishes the way the Preview pane shows it: the same page, the same libraries, nothing to build first. Publish compiles the files, puts the libraries the page uses beside them, and writes a plain site. A page can import only the libraries Vyre provides; if it imports another, Publish names it and builds nothing.

## An app with a server, from a Dockerfile

A folder with a `Dockerfile` at its top can be published as a running app. Create the deployment with `"build": { "image": "dockerfile" }` (add `"port": 8080` unless the Dockerfile has an `EXPOSE` line). Preview builds the image on this server; nothing runs yet. Going live asks once, and the plan you say yes to names the server, its port, and that it has no way out to the internet. Your yes starts it as one of this server's apps, on its own address (`<name>.<your server's name>.vyre.run`), where anyone can reach it.

What it gets and does not get:
- Secrets: grant a Vault secret to the deployment (`publish.secret.grant` with `"use": ["runtime"]`, your yes) and it is in the app's environment under the name you gave. Taking the grant away restarts the app without it.
- A place to keep data: the folder `/data` survives restarts and new versions. Make it writable by the user your app runs as in the Dockerfile (`RUN mkdir /data && chown node /data`). Everything else in the app is read-only except `/tmp`.
- Limits: 512 MB of memory, half a CPU and 256 processes, the same hardening as Vyre's own apps (no extra privileges, no capabilities), and no way to reach anything outside its own network. Nothing of yours is mounted into it.
- Visitors: your app sees each visitor's own cookies and headers, never your Vyre sign-in. Its cookies stay on its own address. WebSockets work the same way (live pages, chat widgets); one idles out after ten minutes without a message.
- The build: it runs in a locked-down builder, not on the server itself. It may start from official images (node, python, nginx and the like) and from registries you allow in the setting `builder.from`; a Dockerfile that names another base, or its own build frontend (`# syntax=`), is refused. The build can reach the internet to fetch packages. The folder is read like any folder: `.env`, keys and `.git` are not in it.
- A new version replaces the running one; if it does not answer its health check, the old one is started again and nothing goes live. Rolling back starts the previous image. Retiring removes the app and keeps its data.

On a server made by the Linux installer, the server's host helper builds and runs the image for you, the same way and with the same limits (it needs the helper that came with the installer; `vyre space-helper install` updates it). On that kind of server the build cannot use build-time secrets yet, only run-time ones.

## Not here yet

This server builds a folder of ready files, and an app from a folder with a Dockerfile. A site that needs a build command (a framework, a bundler) and a build from a repo or a Drive folder need the container builder for those, which is not installed here yet; Publish says so in those words when you ask. Until the public door is on, `publish.quick` says "Public once the public door is on" with the answer: the address works on your own devices only. Serving the site on the public internet also depends on the server's public door being set up.
