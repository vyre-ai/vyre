// The comparison pages on vyre.run: an index at /compare/ and one page for each kind of tool a buyer weighs Vyre against.
// scripts/gen-site.mjs calls buildCompare() with its page helpers and reads back the sitemap rows and the lines for llms.txt and llms-full.txt.
// Rules for the words here: describe approaches, never disparage, and say about another product only what its own public documentation says.
// Where that is not certain the line describes the kind of tool. What Vyre does follows docs/architecture (overview, flows, gate, vault, records, agents).
// Anything planned is marked Next with its version.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The six things that make Vyre different, in one place so every page says them the same way.
const TRAITS = [
  ['Your own server', 'Vyre runs on a server you own. Records, files, Flows and the history stay there.'],
  ['People and agents together', 'Both are members of the same Space. They share chats, records, tasks and files.'],
  ['Flows that repeat', 'A Flow is a stored list of steps. A person approves a version, and every run follows that version.'],
  ['A yes before anything leaves', 'An email, a payment, a deletion or a published page waits at the Gate. An agent can ask. It cannot approve.'],
  ['Sealed fields, use-only credentials', 'An agent sees a placeholder where a sealed value sits, and it uses a Vault credential without reading it.'],
  ['Any model, your own computer', 'Claude, Codex, Grok and OpenRouter through your own accounts or keys. A session can run on a person’s own computer, in a sandbox.'],
];

const PAGES = [
  {
    key: 'automation-tools', og: 'compare-automation',
    name: 'Automation tools', tools: 'Zapier, Make and n8n',
    title: 'Vyre and automation tools: Zapier, Make and n8n',
    desc: 'How Vyre’s approach compares with Zapier, Make and n8n: where app-to-app automation is strong, where Vyre differs, and how the two work together.',
    h1: ['Vyre and ', 'automation tools.'],
    lead: 'Zapier, Make and n8n connect apps. Vyre keeps the work, the people and the agents in one place and runs Flows over them. The two fit together well, and this page shows where each is the better tool.',
    ogSub: 'Zapier, Make and n8n connect apps. Vyre runs the work around them.',
    forCat: ['Zapier, Make and n8n are workflow automation tools. A trigger in one app starts actions in others.', 'They suit operations, marketing and technical teams that want to link the apps they already use, often without writing code.'],
    forVyre: ['Vyre is for a team that wants the work itself in one place: the records, the tasks, the files and the agents that act on them.', 'A Flow in Vyre starts from that work, such as a record entering a stage, and it can hand a step to an agent.'],
    good: [
      ['A large catalogue of app connections', 'Each of the three offers a wide library of ready-made connections to other products.'],
      ['Fast for a single link', 'One trigger and one action can be running in minutes.'],
      ['Visual builders', 'People who do not write code build and read automations on a canvas.'],
      ['Run history', 'Each shows what ran and what failed, and teams that run them every day know how to read it.'],
      ['Choice of hosting', 'Zapier and Make are hosted services. n8n can also be run on your own server.'],
    ],
    diff: [
      ['Flows start from your work', 'A Flow can start when a record is created or changes, when a record enters a stage, on a schedule, from a form, or when something new arrives in a mailbox or folder.'],
      ['A person approves a version', 'Editing a Flow makes a new version. A person approves it before it runs, and a saved test that fails blocks the approval. You can go back to an earlier version.'],
      ['Judgment is one step you place', 'A Flow follows its steps the same way each run. When a step needs judgment, you hand it to an agent, which finishes the task, hands it on, or marks it stuck with a reason.'],
      ['Sends wait at the Gate', 'A Flow that emails a customer holds the message until a person has read the exact words and approved them. An approved Flow version can carry one yes for named destinations and limits.'],
      ['The Flow has the approver’s reach', 'A Flow runs with no more authority than the person who approved it, and every step is checked the way a person’s own action is.'],
      ['Credentials stay sealed', 'A Flow or an agent uses a login from the Vault. The value is put in at the moment of sending and a model never sees it.'],
    ],
    diagram: [
      ['An app you already automate', 'A Zap, scenario or workflow fires on a new form entry'],
      ['A Vyre Flow starts', 'The call reaches the Flow’s path and creates the record'],
      ['An agent drafts the reply', 'It works from the record, the price list and the file'],
      ['The Gate holds the email', 'A person reads the exact words and approves'],
    ],
    diagramNote: 'One way to combine them. The automation tool keeps doing the app-to-app link it already does well.',
    rows: [
      ['Where it runs', 'Zapier and Make are hosted by the vendor. n8n is hosted or self-hosted.', 'On a server you own.'],
      ['What starts work', 'A trigger in a connected app.', 'A person, a schedule, a record change or stage, a form or inbound call, or something new in a mailbox or folder.'],
      ['What it works on', 'Data passed from one app to another.', 'Records, tasks and files kept in the same place as the Flow.'],
      ['Judgment steps', 'Many include AI steps.', 'An agent step you place on purpose. A task it cannot finish is marked stuck, with a reason.'],
      ['Changing a live automation', 'Set by each tool.', 'An edit is a new version. A person approves it, and an earlier version can be restored.'],
      ['Outward actions', 'Set by how each automation is built.', 'Held at the Gate until a person approves the exact words.'],
      ['Credentials', 'Held in each tool’s own connection store.', 'The Vault. Agents get use only and never read the value.'],
      ['Ready-made app connections', 'A large catalogue.', 'A connection to any service that has an API, used from a Flow’s web step. Next (0.5.2): packaged Integrations.'],
      ['Cost', 'Set by each vendor.', 'Vyre is free and open source (Apache 2.0). You pay your AI providers directly.'],
    ],
    together: [
      'Keep the automations that work. A Zap, scenario or workflow can call a Vyre Flow’s path when something happens in an app, and the Flow takes over with the records, the agents and the Gate. A Flow’s web step can call an automation tool’s webhook when you want its connection to an app Vyre does not yet package.',
      'A useful split: let the automation tool carry data between apps, and let Vyre decide what the team does with it and who says yes.',
    ],
    faq: [
      ['Does Vyre replace Zapier, Make or n8n?', 'Not for connecting many apps. Those tools have large catalogues of ready-made connections. Vyre runs Flows over your records and agents, and it can sit next to them. Packaged Integrations for popular apps are Next, in 0.5.2.'],
      ['Can a Flow call an outside service today?', 'Yes. A Flow has a web step, and a person can add a connection that declares the host, how the key is sent and which operations are reads, drafts, changes, sends, spends or deletes.'],
    ],
    connects: [['/architecture/', 'The architecture: the door, the kernel and the Gate'], ['FLOWS', 'Flows, in the repository'], ['GATE', 'The Gate, in the repository'], ['VAULT', 'The Vault, in the repository']],
  },
  {
    key: 'work-management', og: 'compare-work',
    name: 'Work management', tools: 'Notion, ClickUp, Asana and Monday',
    title: 'Vyre and work management tools: Notion, ClickUp, Asana, Monday',
    desc: 'How Vyre compares with Notion, ClickUp, Asana and Monday: what planning tools do well, how Vyre adds agents as members who take tasks, and how to use both.',
    h1: ['Vyre and ', 'work management.'],
    lead: 'Notion, ClickUp, Asana and Monday help a team plan and track work. Vyre adds agents that take tasks, a Gate on what leaves, and a server you own. Many teams will use both.',
    ogSub: 'Planning tools organise the work. Vyre also lets agents do it.',
    forCat: ['Notion, ClickUp, Asana and Monday are hosted workspaces for planning and tracking work. They hold tasks, boards, timelines, documents and dashboards.', 'They suit teams that want one shared place to see who is doing what and when.'],
    forVyre: ['Vyre is for a team whose work is partly done by AI agents, and that wants those agents to take tasks the way a colleague does.', 'It also keeps the records the work is about, such as clients, jobs and cases, linked to the tasks.'],
    good: [
      ['Views people already know', 'Boards, lists, calendars and timelines, refined over many years.'],
      ['Templates and a familiar interface', 'A new teammate or an outside client often knows the tool already.'],
      ['Docs and wikis next to tasks', 'Notion in particular puts pages, databases and notes in one workspace.'],
      ['Reporting dashboards', 'Portfolio and workload views for managers.'],
      ['A large ecosystem', 'Integrations, templates and a community of people who can help.'],
    ],
    diff: [
      ['Agents are members', 'An agent has a job, instructions in its own AGENTS.md, the projects it can reach and a share of the Vault. A task assigned to it wakes it. It finishes the task, hands it on, or marks it stuck.'],
      ['Records of any shape', 'Beside tasks, a Space holds contacts, organizations, projects and record types you define, linked in any web, with boards by stage, calendars and dashboards.'],
      ['Playbooks run each kind of work', 'A Playbook lists the stages and tasks of one kind of job and who does each: a person, a role or an agent. It goes live when an owner approves it.'],
      ['Flows between the stages', 'Where a Playbook sets the stages, a Flow does the actions between them, and a person approves each version.'],
      ['Sends wait at the Gate', 'An agent that finishes a task cannot email the client on its own. The Gate holds the message until a person approves it.'],
      ['Your data on your server', 'Records, files and history are kept on a server you own. Sealed fields show an agent a placeholder.'],
    ],
    diagram: [
      ['The board your team uses', 'A task or status changes in the planning tool'],
      ['A Vyre Flow reads it', 'Through a connection and a web step, where the vendor provides an API'],
      ['An agent does the task', 'It works in the project and hands the task on or marks it stuck'],
      ['A person approves the send', 'The result goes out once the Gate has a yes'],
    ],
    diagramNote: 'One way to combine them. The board stays where your team already looks.',
    rows: [
      ['Where it runs', 'Hosted by the vendor.', 'On a server you own.'],
      ['Unit of work', 'Tasks, items, pages and databases.', 'Tasks, plus records of any type you define, linked to each other.'],
      ['Who does the work', 'People. Most of these tools now include AI features that help inside the tool.', 'People and agents, both as members. An agent takes a task, then finishes, hands on or marks it stuck.'],
      ['Process', 'Project and board templates.', 'Playbooks: stages, tasks and who does each. An owner approves one before it goes live.'],
      ['Automation', 'Built-in rules and automations.', 'Flows: stored steps, a person approves each version, every run follows it.'],
      ['Views', 'Boards, lists, calendars, timelines and dashboards.', 'Boards by stage, calendars by date and dashboards over any record type.'],
      ['Documents', 'Pages and docs inside the tool.', 'Your own Word templates filled from records, with signing for people who have no account.'],
      ['Outward actions', 'Set by how each automation is built.', 'Held at the Gate until a person approves the exact words.'],
      ['Sensitive fields', 'The tool’s own permission settings.', 'Sealed fields show an agent a placeholder, and fields can be hidden from named roles.'],
    ],
    together: [
      'Keep the board your team already reads. Where the vendor provides an API or an MCP server, a connection lets a Flow read or update it, and a person can add the MCP server for agents to use. Vyre then holds the records, the agent work and the approvals, and the planning tool shows the status.',
      'Teams that want one place for everything can run the work in Vyre alone: tasks, Playbooks and boards by stage are all there.',
    ],
    faq: [
      ['Can an agent take a task in Vyre?', 'Yes. When a task is given to an agent, by a person, by a Flow or by another agent, the agent starts with the task, its record and where it came from. It finishes the task, hands it on, or marks it stuck with a reason, and a stuck task appears under Needs you.'],
      ['Does Vyre import from the tools on this page?', 'Excel or CSV imports into any list from the web app. A connection or a custom module can reach a planning tool that has an API. Packaged Integrations are Next, in 0.5.2.'],
    ],
    connects: [['/architecture/', 'The architecture: layers, calls and agent turns'], ['AGENTS', 'Agents, in the repository'], ['TASKS', 'Tasks, Needs you and Playbooks, in the repository'], ['RECORDS', 'Records, in the repository']],
  },
  {
    key: 'ai-assistants', og: 'compare-assistants',
    name: 'AI assistants and agent platforms', tools: 'ChatGPT team workspaces, Claude for teams and agent builders',
    title: 'Vyre and AI assistants: team workspaces and agent platforms',
    desc: 'How Vyre compares with team AI assistants such as ChatGPT team workspaces and Claude for teams, and with agent builders: what each does well and how they combine.',
    h1: ['Vyre and ', 'AI assistants.'],
    lead: 'A team AI workspace gives people a strong assistant from one vendor. Vyre gives a team and its agents a shared place to work, on any model, with a person’s yes before anything leaves. Vyre uses these assistants as its models.',
    ogSub: 'The assistants are the brains. Vyre is where the team and its agents work.',
    forCat: ['Team workspaces such as ChatGPT team plans and Claude for teams give each person a hosted assistant from one vendor, with shared projects and connections to common apps.', 'Agent builders let a developer define an agent with instructions and tools and run it on the vendor’s platform.'],
    forVyre: ['Vyre is for a team that wants several people and several agents in one place, working on shared records, tasks and Flows.', 'It runs on your server and uses the models you already pay for.'],
    good: [
      ['The vendor’s newest models and features', 'The people who build the model also build the assistant around it.'],
      ['Nothing to run', 'You sign up, invite the team and start. The vendor operates it.'],
      ['Polished apps', 'Chat apps on the web, desktop and phone, with admin controls for the organisation.'],
      ['Connections to common apps', 'Connectors let an assistant read from and act in products your team already uses.'],
      ['Agent builders for custom agents', 'A developer can wire tools and instructions into an agent without hosting the model.'],
    ],
    diff: [
      ['Any model, one chat', 'Claude, Codex, Grok and OpenRouter answer in the same chat through your own accounts or keys. Changing provider mid-conversation does not lose the conversation.'],
      ['Agents have a role and a reach', 'Each agent has its own job, instructions and the projects it can reach. What it may do is never more than the person who started it.'],
      ['The work lives beside the chat', 'Records, tasks, files and Flows sit in the same Space as the conversation, so an agent works on the real thing.'],
      ['Sessions on your own computer', 'A session can run on a person’s own computer, in a sandbox with an encrypted workspace, or on the server. The chat shows which.'],
      ['Sends wait at the Gate', 'An agent can ask to send. A person approves the exact words with a proof made on their own device.'],
      ['Credentials stay out of the model', 'A model sees a placeholder. The real value goes in at the moment of sending, outside the model.'],
    ],
    diagram: [
      ['A person asks an assistant', 'In Claude, or any outside AI tool connected over MCP'],
      ['Vyre checks the caller', 'It works out who is calling and applies that role’s tool list'],
      ['Records, Flows and agents act', 'The work happens in the Space, as the person or agent'],
      ['The Gate holds what leaves', 'A person approves the exact words'],
    ],
    diagramNote: 'An outside AI tool reaches Vyre through the same door as the app does.',
    rows: [
      ['Where it runs', 'The vendor’s cloud.', 'A server you own. Sessions run there or on a person’s own computer.'],
      ['Models', 'The vendor’s own models.', 'Claude, Codex, Grok and OpenRouter, through your own accounts or keys.'],
      ['Shared work', 'Shared workspaces for chats and files.', 'Records, tasks, files and Flows in the same Space as the chats.'],
      ['Who can act', 'A person prompts. Connectors and agents act inside the product.', 'People and agents are members with a role and a reach. An agent has no more authority than the person who started it.'],
      ['Repeatable processes', 'Saved instructions and prompts. Agent builders define workflows in code or configuration.', 'Flows: stored steps, a person approves each version, every run follows it.'],
      ['Outward actions', 'Set by each product’s connectors and permissions.', 'Held at the Gate until a person approves the exact words.'],
      ['Credentials', 'Connectors sign in with an account.', 'The Vault. Agents get use only and never read the value.'],
      ['Getting started', 'Sign up and invite people.', 'Set up a server you own, then pair the Vyre app.'],
    ],
    together: [
      'Keep the assistants. Vyre signs in to your own provider accounts and uses them as the models for its agents, so the team keeps the vendor’s models and adds a shared place to work. An outside AI tool connected over MCP can ask Vyre to do work, and the call is checked like any other.',
      'Use the assistant for the thinking and Vyre for the work: the records it reads, the Flow it runs and the yes that lets the result out.',
    ],
    faq: [
      ['Does Vyre include its own model?', 'No. Vyre is free, and you pay your AI providers directly. It runs Claude, Codex, Grok and OpenRouter through your own subscriptions or keys.'],
      ['Which AI accounts does Vyre work with?', 'The ones you add. Vyre works with Claude, Codex, Grok and others through your own sign-ins and keys, and one chat can hold more than one.'],
    ],
    connects: [['/architecture/', 'How an agent’s turn runs, and the door every call passes'], ['SESSIONS', 'Sessions and models, in the repository'], ['MCP', 'MCP and the Engineer, in the repository'], ['AGENTS', 'Agents, in the repository']],
  },
  {
    key: 'practice-software', og: 'compare-practice',
    name: 'Practice software and CRM suites', tools: 'Clio, Karbon and HubSpot',
    title: 'Vyre with practice software and CRMs: Clio, Karbon, HubSpot',
    desc: 'Use Clio, Karbon, HubSpot or a similar suite with Vyre: the suite stays your system of record, and Vyre gives your people and agents a place to do the work around it.',
    h1: ['Vyre with ', 'practice software.'],
    lead: 'Practice management and CRM suites are built for one job and do it well. Vyre does not replace them. It adds a working layer beside them, where people and agents do the intake, drafting, follow-up and review, with a yes before anything goes out.',
    ogSub: 'Keep your system of record. Add a place where agents do the work.',
    forCat: ['Clio is practice management for law firms. Karbon is practice management for accounting firms. HubSpot is a CRM with marketing and sales tools. Each is a hosted system built for its field.', 'They suit firms and teams that want one dependable record of clients, work and communication.'],
    forVyre: ['Vyre is for a professional services team that wants agents doing real work around that record: first contact, document drafts, reminders and reviews.', 'It is industry-neutral. You shape the records, and starter Kits supply record types and Flows to begin from.'],
    good: [
      ['Built for one profession or function', 'The record types, terms and screens match how the field works.'],
      ['A system of record', 'Clients, work, communication and history sit in one dependable place that the whole firm uses.'],
      ['Established ecosystems', 'Each has partners, integrations and people who know it well.'],
      ['Years of fit with daily practice', 'They reflect how firms in that field actually run their day.'],
      ['Vendor support and a hosted service', 'The vendor runs it, updates it and answers questions.'],
    ],
    diff: [
      ['A working layer, not a replacement', 'Vyre does not aim to replace your billing or your system of record. It holds the working records and the agent work around them.'],
      ['Agents do the preparation', 'An agent can read a new enquiry, draft a reply from your price list or fill a document, and then stop for a person.'],
      ['Documents from your templates', 'Your own Word templates are filled from a record and its linked records, and a model does not retype them. Signing needs no account for the signer.'],
      ['Sends wait at the Gate', 'Anything that goes to a client, a payment or a deletion waits until a person has read the exact words and approved them.'],
      ['Your server holds the working data', 'Records, files and the history of every decision stay on a server you own. Sealed fields keep the most sensitive values away from agents.'],
      ['Shaped to your business', 'Define record types and fields in your own words, link them, and give each kind of work its own Playbook and Flows.'],
    ],
    diagram: [
      ['Your system of record', 'Holds the client, the matter or engagement and the bill'],
      ['A connection and a Flow web step', 'Read what is needed, where the vendor provides an API'],
      ['Vyre’s agents prepare the work', 'A draft, a document from a template, a summary'],
      ['A person approves', 'The Gate releases it, and the record is updated'],
    ],
    diagramNote: 'One way to combine them. The suite stays the source of truth.',
    rows: [
      ['What it is for', 'Clio: legal practice management. Karbon: accounting practice management. HubSpot: CRM, marketing and sales.', 'A shared working layer for people and agents, with records you shape, Flows, Documents and Signing, Sites and a Gate.'],
      ['Where it runs', 'Hosted by the vendor.', 'On a server you own.'],
      ['Specialised to a profession', 'Yes, to the field each was built for.', 'Industry-neutral. Kits supply starter record types and Flows.'],
      ['Agents', 'Many include AI features inside the product.', 'Agents are members of the Space and work across its records, tasks and files.'],
      ['Documents', 'Document features vary by product.', 'Your Word templates filled from records, signing with no account for the signer.'],
      ['Outward actions', 'Set by how each product and automation is configured.', 'Held at the Gate until a person approves the exact words.'],
      ['Connecting to the suite', 'Native to the suite.', 'Today: a connection plus a Flow web step, or a custom module, where the vendor provides an API. Next (0.5.2): packaged Integrations.'],
    ],
    together: [
      'Vyre can be extended by integrating your Zoho, QuickBooks, RingCentral and the rest of your software stack*, and the same goes for Clio, Karbon and HubSpot. The suite stays the system of record. Vyre reads from it, does the preparation, and writes back once a person has said yes.',
      '*Where the vendor provides an API. Integrations as packaged modules are Next, in 0.5.2. Today a person adds a connection and a Flow uses it from a web step, or a custom module wraps the service.',
    ],
    faq: [
      ['Do I have to move my data out of Clio, Karbon or HubSpot?', 'No. Keep the system of record where it is. Vyre holds the working records and the agent work around it, and a connection lets a Flow read from the suite where the vendor provides an API.'],
      ['Is Vyre built for law or accounting?', 'Vyre is industry-neutral. Any AI agent can follow the Map your business onto Vyre method to design a setup for your field.'],
    ],
    connects: [['/architecture/', 'The architecture, on one page'], ['MAP', 'Map your business onto Vyre, the method an agent follows'], ['DOCS', 'Documents and signing, in the repository'], ['RECORDS', 'Records, in the repository']],
  },
];

export function buildCompare(h) {
  const { page, eyebrow, faqHtml, faqLd, crumbs, SITE, REPO, MAP_URL } = h;
  const feat = (f) => `${REPO}/blob/main/docs/architecture/features/${f}.md`;
  const LINKS = { FLOWS: feat('flows'), GATE: feat('gate'), VAULT: feat('vault'), AGENTS: feat('agents'), TASKS: feat('tasks-and-needs-you'), RECORDS: feat('records'), SESSIONS: feat('sessions-and-models'), MCP: feat('mcp-and-engineer'), DOCS: feat('documents-and-signing'), MAP: MAP_URL };
  const href = (k) => LINKS[k] || k;

  const traitsHtml = `<div class="ar-table rv">${TRAITS.map(([t, d]) => `<div><p class="lbl">${t}</p><p>${d}</p></div>`).join('')}</div>`;

  const connects = (items) => `<div class="note rv"><p class="lbl" style="margin-bottom:8px">Connects to</p><ul class="plain" style="margin:0;padding-left:1.1em">${items.map(([k, t]) => `<li style="margin:.3em 0"><a href="${href(k)}">${t}</a></li>`).join('')}<li style="margin:.3em 0"><a href="/compare/">The other comparisons</a></li><li style="margin:.3em 0"><a href="/start/">Set up Vyre</a></li></ul></div>`;

  const table = (c) => `<table class="cmp-table rv">
        <caption class="cmp-cap">${esc(c.name)} compared with Vyre, one row for each question a buyer asks</caption>
        <thead><tr><th scope="col">Question</th><th scope="col">${esc(c.name)}</th><th scope="col">Vyre</th></tr></thead>
        <tbody>${c.rows.map(([q, a, b]) => `<tr><th scope="row">${q}</th><td data-label="${esc(c.name)}">${a}</td><td data-label="Vyre">${b}</td></tr>`).join('')}</tbody>
      </table>`;

  const flow = (c) => `<ol class="cmp-flow rv" aria-label="One way ${esc(c.name.toLowerCase())} and Vyre work together, in four steps">${c.diagram.map(([t, d], i) => `<li class="cmp-step"><span class="cmp-n">0${i + 1}</span><b>${t}</b><span>${d}</span></li>`).join('')}</ol><p class="cmp-note">${c.diagramNote}</p>`;

  const out = { sitemap: [['/compare/', '0.8']], llms: [], full: [] };

  for (const c of PAGES) {
    const path = `/compare/${c.key}/`;
    const body = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / <a href="/compare/">Compare</a> / ${esc(c.name)}</p>
    ${eyebrow(`${c.tools}.`)}
    <h1 class="display">${c.h1[0]}<b>${c.h1[1]}</b></h1>
    <p class="lead">${c.lead}</p>
  </div>
</section>

<section class="sec" style="padding-top:56px" aria-labelledby="who-h">
  <div class="wrap">
    <h2 id="who-h" class="lbl" style="margin-bottom:20px">Who each is for</h2>
    <div class="cmp-two rv">
      <div class="cmp-col"><h3>${esc(c.name)}</h3>${c.forCat.map((p) => `<p>${p}</p>`).join('')}</div>
      <div class="cmp-col cmp-col-v"><h3>Vyre</h3>${c.forVyre.map((p) => `<p>${p}</p>`).join('')}</div>
    </div>
  </div>
</section>

<section class="sec" aria-labelledby="good-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('What they do well.')}
      <h2 id="good-h" class="h2">Where ${esc(c.name.toLowerCase())} <b>are strong.</b></h2>
    </div>
    <ul class="cmp-good rv">${c.good.map(([b, s]) => `<li><b>${b}</b><span>${s}</span></li>`).join('')}</ul>
  </div>
</section>

<section class="sec" aria-labelledby="diff-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Where Vyre is different.')}
      <h2 id="diff-h" class="h2">Six things Vyre does <b>its own way.</b></h2>
    </div>
    <div class="ar-ideas rv">${c.diff.map(([t, d], i) => `<div class="piece"><span class="num">0${i + 1}</span><h3>${t}</h3><p>${d}</p></div>`).join('')}</div>
  </div>
</section>

<section class="sec" aria-labelledby="table-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Side by side.')}
      <h2 id="table-h" class="h2">The two approaches, <b>row by row.</b></h2>
      <p class="lead">The left column describes the kind of tool, from its public documentation. Where a product differs, its own documentation is the one to trust.</p>
    </div>
    ${table(c)}
  </div>
</section>

<section class="sec" aria-labelledby="together-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('How they work together.')}
      <h2 id="together-h" class="h2">Use both, <b>and let each do its part.</b></h2>
    </div>
    ${flow(c)}
    <div class="cmp-prose rv">${c.together.map((p) => `<p>${p}</p>`).join('')}</div>
  </div>
</section>

<section class="sec" aria-labelledby="faq-h">
  <div class="wrap">
    <h2 id="faq-h" class="lbl" style="margin-bottom:20px">Questions people ask</h2>
    ${faqHtml(c.faq)}
  </div>
</section>

<section class="sec" aria-labelledby="conn-h">
  <div class="wrap">
    <h2 id="conn-h" class="lbl" style="margin-bottom:20px">Go deeper</h2>
    ${connects(c.connects)}
  </div>
</section>

<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">See it <b>working.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="/compare/">All comparisons</a></div></div></section>`;
    page({
      slug: c.og, path,
      title: c.title, desc: c.desc, ogTitle: `${c.h1[0]}${c.h1[1]}`, ogSub: c.ogSub, body,
      ld: [crumbs([['Vyre', `${SITE}/`], ['Compare', `${SITE}/compare/`], [c.name, SITE + path]]), faqLd(c.faq)],
    });
    out.sitemap.push([path, '0.7']);
    out.llms.push(`- [${c.title}](${SITE}${path}): ${c.desc}`);
    out.full.push(`### ${c.title} (${SITE}${path})
${c.lead}
- Who ${c.name.toLowerCase()} are for: ${c.forCat.join(' ')}
- What they do well: ${c.good.map(([b, s]) => `${b}. ${s}`).join(' ')}
- Where Vyre is different: ${c.diff.map(([t, d]) => `${t}. ${d}`).join(' ')}
- How they work together: ${c.together.join(' ')}
- Comparison:
${c.rows.map(([q, a, b]) => `  - ${q}. ${c.name}: ${a} Vyre: ${b}`).join('\n')}`);
  }

  const cards = PAGES.map((c, i) => `<div class="piece"><span class="num">0${i + 1}</span><h3>${esc(c.name)}</h3><p>${esc(c.tools)}. ${c.ogSub}</p><p><a href="/compare/${c.key}/">Read the comparison</a></p></div>`).join('');
  const indexBody = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Compare</p>
    ${eyebrow('How Vyre fits with the tools you use.')}
    <h1 class="display">Vyre next to <b>the tools you have.</b></h1>
    <p class="lead">Most teams already run on automation tools, a planning tool, an AI assistant and a system of record for their field. Vyre is the place where people and agents work together on top of them. These pages compare the approaches, one kind of tool at a time, and say how to use them together.</p>
  </div>
</section>

<section class="sec" style="padding-top:56px" aria-labelledby="four-h">
  <div class="wrap">
    <h2 id="four-h" class="lbl" style="margin-bottom:20px">Four comparisons</h2>
    <div class="cmp-two rv">${cards}</div>
  </div>
</section>

<section class="sec" aria-labelledby="trait-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('What stays the same on every page.')}
      <h2 id="trait-h" class="h2">Six things that set Vyre <b>apart.</b></h2>
      <p class="lead">Each comparison starts from the same six points about how Vyre is built, so you can read them against any tool.</p>
    </div>
    ${traitsHtml}
  </div>
</section>

<section class="sec" aria-labelledby="fair-h">
  <div class="wrap">
    <h2 id="fair-h" class="lbl" style="margin-bottom:20px">How these pages are written</h2>
    <div class="note rv"><p style="margin:0 0 10px">The other tools on these pages are good at what they were built for. Each page says what its kind of tool does well before it says where Vyre differs. About another product, a page says only what that product’s own public documentation says. Where we are not sure, the page describes the kind of tool. If a line is out of date, <a href="${REPO}/issues">tell us in the repository</a>.</p><p style="margin:0">Vyre can be extended by integrating your Zoho, QuickBooks, RingCentral and the rest of your software stack*. *Where the vendor provides an API. Packaged Integrations are Next, in 0.5.2.</p></div>
  </div>
</section>

<section class="sec" aria-labelledby="conn-h">
  <div class="wrap">
    <h2 id="conn-h" class="lbl" style="margin-bottom:20px">Connects to</h2>
    <div class="note rv"><ul class="plain" style="margin:0;padding-left:1.1em"><li style="margin:.3em 0"><a href="/architecture/">The architecture, on one page</a></li><li style="margin:.3em 0"><a href="/direction/">Direction: what comes next</a></li><li style="margin:.3em 0"><a href="${MAP_URL}">Map your business onto Vyre, for an AI agent to follow</a></li><li style="margin:.3em 0"><a href="/start/">Set up Vyre</a></li></ul></div>
  </div>
</section>

<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">See it <b>working.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="/architecture/">Read the architecture</a></div></div></section>`;
  page({
    slug: 'compare', path: '/compare/',
    title: 'Compare Vyre with automation, work management and AI tools',
    desc: 'How Vyre fits next to automation tools, work management tools, AI assistants and practice software: what each does well, where Vyre differs and how to use them together.',
    ogTitle: 'Vyre next to the tools you have.', ogSub: 'Automation, planning, AI assistants and practice software, and how they fit with Vyre.',
    body: indexBody, ld: [crumbs([['Vyre', `${SITE}/`], ['Compare', `${SITE}/compare/`]])],
  });
  out.llms.unshift(`- [Compare Vyre with other tools](${SITE}/compare/): how Vyre fits next to automation tools, work management tools, AI assistants and practice software`);
  out.llmsBlock = `## Compare\n${out.llms.join('\n')}\n`;
  out.fullBlock = `## How Vyre compares\nEach page below describes approaches. About another product it says only what that product’s own public documentation says, and otherwise it describes the kind of tool. Vyre can be extended by integrating your Zoho, QuickBooks, RingCentral and the rest of your software stack*. *Where the vendor provides an API. Packaged Integrations are Next, in 0.5.2.\n\n${out.full.join('\n\n')}\n`;
  return out;
}
