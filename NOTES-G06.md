# G06 tool finding: state when paused (11 Oct, rc1-d)

Branch work/rc3/g06, tip db1473d4d. Nothing queued. Paused by the owner's order for tonight (rc.1 and rc.2 only).

DONE (offline numbers on the test box; the sealed set is never tuned on)
- 1a skills in the one index (lib/tools-extras.js skillEntries, harness/mcp/server.js): group skills.use, ready tools_call, scope = skills.list's.
- 1b learned site ops (memory.site.learned, siteEntries): own session only, Chrome tool in the catalog, names and input names only.
- 2a router operations (workEntries): work.tools entries returned with the ready work_call. Dev 63/92 first (unchanged), sealed 137 -> 140/202; top-3 unchanged; tuned sets unchanged.
- Tried and reverted: asks generated from the nomenclature table (dev 62, sealed 139: noise; the table's verb is "update" for 631 of 1360 tools).

MISSES (94 top-1: dev 29, sealed 65): router-ish 20 (mostly work_situation / work_team_doing / work_timeline, not work_call), overlap 35, multi-step 20, other 19. Overlap by family: open-a-site 8, previews/publish 7, flows 6, mail 5, calendar 3, connections 2, memory 2. Scored with multi-step as correct: dev 74%, sealed 75%.

NEXT (owner lines: the decisions file, "Tool naming and finding", 10 Oct: "Merge overlapping tools, group them by area, and rewrite names and descriptions."; the backlog: "the next lever is fewer overlapping tools")
- Merge table owed to the lead, in this order: open-a-site, previews/publish, flows, mail, calendar. Proposed single names with all old names kept as aliases (computer.site.use, mail.message.send, time.calendar.*, publish.preview.*, flows.rule.define).
- Asks for work_situation, work_team_doing, work_timeline, flows_attention (dev first, then sealed once).
- No provider eval without the lead's yes (the eval Claude token is at its limit until 16 Oct).
- Not covered by a test yet: the MCP server wiring end to end (needs a session token and a Chrome tool in the catalog): cover it in the install proof.
