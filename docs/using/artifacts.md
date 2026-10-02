---
title: Artifacts
summary: The documents, reports, pages, dashboards, diagrams, decks, apps, images, video and audio your agents make, kept on your server with every version, private unless you share one, and what an interactive page can and cannot do.
audience: users, agents
owner: docs
status: draft
---

# Artifacts

An artifact is something an agent made for you to look at or use: a document, a report, a page, a
dashboard, a diagram, a deck, a small app, or an image, a video or a sound a model generated. Agents
save them with `artifacts_create`, or by putting a file in their artifacts folder, and they show in
the chat as a card that opens in a side panel.

Every artifact lives on your server, in its own small history, and is private to you. An agent
reaches only its own project's artifacts. The assistant reaches all of them. You can tag one into a
chat with `#`, which gives that conversation read access to exactly that item.

## Versions

Each save is a new version, and going back is a new version too, so nothing is lost. You can compare
any two versions. Images, video and audio are one file each: a new one is a new artifact.

## Public links

A public link is off until you turn it on in Settings. A link shows one version, or always the
latest, expires in 30 days unless you choose otherwise, and carries nothing about your project, the
agent or the thread. Sharing counts as posting, so an agent's own share waits for you. Images, video
and audio can be shared the same way; the link serves the file as it is, so a photograph's own
metadata goes with it.

## Documents run no code; pages and apps run their own

Documents, reports, dashboards, diagrams, decks, images, video and audio run no script at all. Vyre
draws them itself from what the agent wrote, in a frame that allows no scripts.

A page or an app is the agent's own HTML, and it is the only kind that runs code. It runs in a
locked frame: it has no cookies and no storage, it cannot reach Vyre or the rest of your screen, and
it cannot load anything from the internet or send a request out. Vyre puts one fixed line under every
page and app, every time: "Runs its own code and can reach the internet". The line is there because
of the one thing the frame cannot stop, described next.

A page can send the browser to another web address by itself, and it can put anything it contains into
that address. Every way a script can leave its page by navigation does this: setting the address, a
meta refresh, and clicking a link, with or without the download attribute. Popups, form posts,
downloads, storage, cookies and the other requests we tested are blocked. We tested this in
Chrome, Safari on a Mac and Safari on an iPhone: a page delivered addresses of about 8,000 bytes to a
server in every one (the test sent 8,000 bytes and the server received addresses of 8,024 to 8,029),
and the browsers accept far longer ones (Chrome takes about 2 MB), so treat the channel as large. The
request is a plain GET: the page cannot read the answer.

So treat a page or an app as able to send out whatever is inside it. Do not let an agent put in one
anything you would not send to the internet, and be careful with an interactive artifact made in a
session that read mail, web pages or other content you did not write. When a page or an app loads a
second time, which means it navigated away, the Deck blanks the frame and shows "This page tried to
open another site", and the artifact's activity records that it left. Where it went is usually not
known to Vyre, because a browser does not tell the surface around a frame where the frame went, so
the log says that it left, not to what address. The log is written from what the Deck sees, so it is
a record to look at, not a guard.

### A known limit in Safari

In Safari on a Mac and on an iPhone, when a page sends itself to your own Vyre address, Safari also
sends your Vyre session cookie with that request, because it judges "same site" from the page around
the frame, not from the frame. Chrome does not. This is not fixed in 0.2.0; the fix is planned for
0.2.1, which makes Vyre's server ignore your session on requests that come from inside a page frame.
Today, what limits the harm is that Vyre's tools are all POST requests, so that GET cannot call a
tool, and a page cannot read the answer to it. If you open interactive artifacts in Safari, open
only ones from sessions you trust, or open them in Chrome until 0.2.1.

## Images, video and audio a model made

When a model generates an image, a video or a sound in a project, Vyre saves the file to that project
as an artifact, with its provenance: the provider and model that made it, the words it was asked for
and the session. The card shows who made it with the provider and model, "Asked for" with the words,
and "Saved in" with the project. A file is accepted only when its
first bytes match its format (png, jpeg, gif, webp, mp4, webm, mp3, wav, ogg, m4a), up to 100 MB each.

- **In Drive**, each project's folder has a **Generated** folder that lists these files, so you find
  them where you keep your other files. Nothing is copied: it shows the artifacts themselves, to
  whoever may see them.
- **Use in** on the card lists the models you can use. Choose one and Vyre starts your next message
  with that model's name and attaches the file to it. You then write what you want and send it.
- **Download** saves the file to your device.

## Backup, restore and uninstall

`vyre backup` carries your artifacts, every version and each generated file, in its sealed file, and
`vyre restore` brings them back. Public links come back as they were when the backup was made. An
uninstall that deletes your data deletes your artifacts with it.
