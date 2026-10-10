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

From the terminal: `vyre call publish.quick '{"name":"bakery","folder":"/path/to/site"}'`. It answers with the preview and a request; `vyre call publish.decide '{"task":"...","approve":true}'` is the yes. A site with the same name replaces the live one, which is kept so you can go back with `publish.rollback`.

Files that look like secrets (an `.env`, a private key), `.git` and `node_modules` are left out and named in the build log, links are never followed, and a folder over 2,000 files or 50 MB is refused. Naming a folder on the server is your act: a model asks you to publish it (from the preview card or the terminal) and never names one itself. A file that holds a key (a GitHub token, an AWS key, a private key) stops the build with the file's name. The plan you say yes to lists how many files go public, how large they are and the first names.

Making it live takes several steps if you want them separately: `publish.create`, `publish.preview`, `publish.approve` and `publish.publish` each hold for your decision. `publish.go` is the shortcut for a version that is already previewed.

## Keys

A site gets the keys it needs from the [Vault](vault.md), one at a time, and only the ones you give it. See "Keys for a published site" there.

## A GitHub repo for the folder

With a GitHub account connected (see [Connectors](connectors.md)), ask for a new repo for the folder: it is made under your account or an organisation you belong to, private unless you say public, and the folder goes there as the first commit.

## A React page

A folder with a React page (`index.jsx`, `index.tsx`, `App.jsx` or `App.tsx`, and no `index.html`) publishes the way the Preview pane shows it: the same page, the same libraries, nothing to build first. Publish compiles the files, puts the libraries the page uses beside them, and writes a plain site. A page can import only the libraries Vyre provides; if it imports another, Publish names it and builds nothing.

## Not here yet

This server builds a folder of ready files. A site that needs a build command (a framework, a bundler), a build from a repo or a Drive folder, and apps with a server need the container builder, which is not installed here yet; Publish says so in those words when you ask. Until the public door is on, `publish.quick` says "Public once the public door is on" with the answer: the address works on your own devices only. Serving the site on the public internet also depends on the server's public door being set up.
