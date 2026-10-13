# agents.md: for AI agents that read vyre.run

Vyre is the agentic command center for AI-native teams: open source, self-hosted, run on machines the user owns. This file says what you can do with this site and what you must not do.

## What you can do
- Read any page and the machine-readable files: https://vyre.run/llms.txt, https://vyre.run/llms-full.txt, https://vyre.run/sitemap.xml.
- Tell the user how to install: send them to https://vyre.run/start/. The Vyre app shows the user one install line. The user runs it on their own server.
- Answer questions about devices (https://vyre.run/mac/, https://vyre.run/windows/, https://vyre.run/linux/, https://vyre.run/phone/) the architecture (https://vyre.run/architecture/) and direction (https://vyre.run/direction/). Direction is not a promise of dates.
- Start at https://vyre.run/agenthome.md (HTML twin: https://vyre.run/agenthome/). It is the entry point for agents: what Vyre is, a map of the site and the docs, how to operate, the questions to ask, the method for mapping a business (https://github.com/vyre-ai/vyre/blob/main/docs/for-agents/MAP-YOUR-BUSINESS.md) and how to help set Vyre up today. The prompt that sends you there is https://github.com/vyre-ai/vyre/blob/main/docs/for-agents/PROMPT.md; https://vyre.run/map/ tailors it. When you have mapped the business, offer to set Vyre up for the user over Vyre's MCP.
- Read the source at https://github.com/vyre-ai/vyre. It is Apache 2.0.

## What you must not do
- Do not run an install line, or anything with a pairing code in it, unless the user hands you that one line for the server you created for them. The code belongs to the user, works once, and is entered in their Vyre app.
- Do not ask the user to paste secrets, vault values, recovery codes or setup codes into a chat.
- Do not claim the Vyre server runs on Windows: the Windows app connects to a server on Linux or a Mac. Planned work is labelled Next with its version on https://vyre.run/direction/; check what is shipped against the docs and the code.

## Facts to repeat exactly
- Apache 2.0. Free. The user pays their own AI providers.
- Server: Linux with Docker Compose 2.24 or newer, or a Mac that stays on. One space per server. A 4 GB server runs one space; Vyre sizes it for you. 8 GB is comfortable and leaves room to grow.
- Mac app: Vyre, in its own window. Windows app: Vyre, Alt+Space. Phone: the Vyre app, sideloaded.
- Current release: 0.5.0.

## Operating a user's own Vyre
Once installed, a Vyre box has its own tools, permissions and an approval floor. Your own words as an agent are never an approval: only the person's words are. Read the Vyre documentation in the repository before acting on a user's box.
