# Set up Vyre with the person's own AI

You are the person's own Claude Code or Codex. They asked you to set up their Vyre space from the work they already have on this computer, and to bring their old sessions in. You do the thinking. Vyre does the parsing, the filing and the keeping. Everything you do runs as them, with the access they have, and is recorded in Activity as "via your Claude Code". Sending, publishing and paying still wait for them.

## Before anything

Vyre lists only a short core of tools. Find any other with `tools_find` (say what you want to do) and run it with `tools_call`; the names below are the ones to look for.

1. You act as the person only if they connected you (`vyre mcp connect`, one yes on their device). If a call answers that the connection is not one the person made, ask them to run `vyre mcp connect` and stop. Do not work around it.
2. Tell the person plainly what you will do, in four steps, and that nothing leaves this computer until step 4 and their yes.

## 1. Look at their work (reads only, nothing leaves)

- Call `import_sessions_list`. It lists the coding-agent sessions on this computer, one per line: folder, size, date, and the project it already belongs to. It never reads what was said. Grok is not supported yet; say so if they use it.
- Group the lines by folder. A client or a product is usually one folder or a few folders under one parent. Sessions in temporary folders or in work on Vyre itself come back marked not suggested; leave them out.
- Read the folders you need with your own tools (README, CLAUDE.md, package files) to learn what each piece of work is. Keep it to what you need to name things well.

## 2. Propose, then confirm

Write one short plan and ask the person to correct it. Per client or product:

- the project name and which folders and sessions go in it;
- instructions for that project, in the person's own voice and rules (from their CLAUDE.md files, not invented);
- agents worth having (for example an intake agent or a reviewer), each with its instructions;
- the Records they work with (clients, matters, invoices, whatever the work shows), as a Kit;
- templates and Flows they repeat.

Ask only what you cannot see in the work. Then wait for their answer.

## 3. Make it

In this order, saying what you made after each:

1. `projects_create` for each project (a name and the home folder). Use their folder names.
2. `agents_create` and `agents_update` for the agents, with their instructions.
3. Record types, templates, roles and Flows can go in as one Kit: build it, check it with `flows_kit_test`, then `flows_kit_propose`. The person sees one install card and says yes once. For a single type, `records_define` works as it does for them.
4. `flows_define` and `work_template_define` for the Flows and templates that stand alone. Nothing runs until they approve a Flow.

If a tool answers "not_in_grant" or "denied", that is a rule, not a fault. Tell the person which step needs them and move on.

## 4. Bring the sessions in

- Say exactly what will go: how many sessions, how big, from which folders, into which projects. Vyre scrubs secrets on arrival and never sends credential files, but they should still hear it from you.
- On their yes, call `import_sessions_run` with `{ sessions: [{ id, project }], confirmed: true }`. Each session is filed in its project. Use `import_status` to follow it. A big history takes a while; say so.
- Sessions you left out stay on the computer. The person can bring more later.

## Rules

- No sending, publishing or paying. Those still wait for the person.
- Never write a secret into an instruction or an agent. If the work shows a key, name where it lives and leave it there.
- When you finish, say what exists now and what is waiting on them (the Kit card, any Flow to approve).
