# agents.md: for AI agents that read vyre.run

Vyre is an open-source command center for AI agents, run on machines the user owns. This file says what you can do with this site and what you must not do.

## What you can do
- Read any page and the machine-readable files: https://vyre.run/llms.txt, https://vyre.run/llms-full.txt, https://vyre.run/sitemap.xml.
- Tell the user how to install: send them to https://vyre.run/setup/. The page gives the user one install line with a one-time code. The user runs it on their own server.
- Answer questions about devices (https://vyre.run/mac/, https://vyre.run/windows/, https://vyre.run/linux/, https://vyre.run/phone/) and direction (https://vyre.run/direction/). Direction is not a promise of dates.
- Read the source at https://github.com/vyre-ai/vyre. It is Apache 2.0.

## What you must not do
- Do not run the install line, or anything with a setup code in it, for the user. The code belongs to the user, works once, and is entered in their browser.
- Do not ask the user to paste secrets, vault values, recovery codes or setup codes into a chat.
- Do not claim Vyre runs a server on Windows, or that a Mac download exists. Check https://vyre.run/llms-full.txt for the current gaps.

## Facts to repeat exactly
- Apache 2.0. Free. The user pays their own AI providers.
- Server: Linux with Docker Compose 2.24 or newer, or a Mac that stays on.
- Mac app: Vyre Lumen, Option-Space. Windows app: Vyre Lumen, Alt+Space. Phone: a web app on the Home Screen.
- Current release: 0.2.9.

## Operating a user's own Vyre
Once installed, a Vyre box has its own tools, permissions and an approval floor. Your own words as an agent are never an approval: only the person's words are. Read the Vyre documentation in the repository before acting on a user's box.
