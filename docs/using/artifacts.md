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
and audio have no public link yet.

## Pages and apps run their own code

A page or an app is the agent's own HTML. It runs in a locked frame: it has no cookies and no
storage, it cannot reach Vyre or the rest of your screen, and it cannot load anything from the
internet or send a request out.

One thing no browser setting stops: a page can send the browser to another web address by itself, and
it can put anything it contains into that address. So treat a page or an app as able to send out
whatever is inside it. Do not let an agent put in one anything you would not send to the internet,
and be careful with an interactive artifact made in a session that read mail, web pages or other
content you did not write. Vyre says so on the frame ("Runs its own code and can reach the internet"),
and when a page or an app loads a second time, which means it navigated away, the artifact's activity
records it.

Documents, reports, dashboards, diagrams and decks run no code and are not affected: Vyre draws them
itself from what the agent wrote.

## Backup, restore and uninstall

`vyre backup` carries your artifacts, every version and each generated file, in its sealed file, and
`vyre restore` brings them back. Public links come back as they were when the backup was made. An
uninstall that deletes your data deletes your artifacts with it.
