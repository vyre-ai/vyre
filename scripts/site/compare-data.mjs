// Data for the one-page-per-product comparisons on vyre.run (/compare/<product>/). scripts/site/compare.mjs renders every entry with one template.
// Rules for the words: say about another product only what its own public documentation says, never disparage, no pricing.
// Where a line could be out of date it describes the kind of product. What Vyre does follows docs/architecture. Planned work is marked Next with its version.

// The groups on the /compare/ index. `page` is the existing kind-of-tool page that lists the group's products, when there is one.
export const GROUPS = [
  { key: 'automation', name: 'Automation', page: 'automation-tools' },
  { key: 'work', name: 'Work management', page: 'work-management' },
  { key: 'crm', name: 'CRM and client management', page: 'practice-software' },
  { key: 'practice', name: 'Practice management', page: 'practice-software' },
  { key: 'docs', name: 'Documents and signing', page: null },
  { key: 'passwords', name: 'Passwords', page: null },
  { key: 'ai', name: 'AI assistants', page: 'ai-assistants' },
  { key: 'sites', name: 'Websites', page: null },
  { key: 'comms', name: 'Communications', page: null },
  { key: 'accounting', name: 'Accounting', page: null },
];

// The parts of Vyre a product can overlap with. Each product picks some and adds a sentence of its own.
export const NATIVE = {
  records: ['Records', 'records'],
  tasks: ['Tasks and Playbooks', 'tasks'],
  flows: ['Flows', 'flows'],
  agents: ['Agents', 'agents'],
  docs: ['Documents and Signing', 'docs'],
  sites: ['Sites', 'sites'],
  vault: ['Vault', 'vault'],
  chat: ['Chat', 'chats'],
  gate: ['The Gate', 'gate'],
};

// Why it helps. Each product picks three or four and adds one line that ties them to its own job.
export const WHY = {
  place: ['One place for people and agents', 'People and agents are members of the same Space. They share the records, tasks, files and chat, so nobody carries data from one tool to the next.'],
  server: ['Data on your own server', 'Records, files and the history of every decision stay on a server you own. Sealed fields show an agent a placeholder.'],
  approved: ['Every outward action approved', 'An email, a payment, a deletion or a published page waits at the Gate until a person has read the exact words and said yes.'],
  agents: ['Agents do the work', 'An agent takes the task and finishes it, hands it on or marks it stuck with a reason. A person is not moving data between tools by hand.'],
  fewer: ['Fewer subscriptions and less copy-paste', 'One Space covers parts of a job that took several tools, so there are fewer logins and fewer places to keep in step.'],
  rules: ['Rules decide, not a model', 'A Flow follows stored steps and a person approves each version, so the same input takes the same path every run. A model is one step you place on purpose.'],
};

const TODAY = 'A person adds a Connection in the Vault that declares the host, how the key is sent and which operations read, draft, change, send, spend or delete. A Flow then calls the service from a web step, or a custom module wraps it.';
const NEXT = 'Coming in 0.7: a packaged Integration, so the Connection and its operations arrive ready-made.';
const NOAPI = 'Check the vendor’s developer documentation for what it offers. Where there is nothing to call, a person can export a list and import the CSV into a Records type, and a custom module can wrap anything that has an endpoint.';

// p(key, group, name, details). strong: three [bold, plain] pairs. use: [[nativeKey, sentence]]. mode: part (Vyre covers part of the job), whole (a team can drop it for most uses), with (keep it, Vyre works alongside).
const p = (key, group, name, d) => ({ key, group, name, api: true, mode: 'part', host: 'Hosted by the vendor.', ...d });

export const PRODUCTS = [
  // Automation
  p('zapier', 'automation', 'Zapier', {
    what: 'Connects apps with triggers and actions.', who: 'Operations and marketing teams that want to link the apps they already use, often without writing code.',
    strong: [['A very large catalogue', 'Ready-made connections to a wide range of products.'], ['Fast for one link', 'One trigger and one action can run within minutes.'], ['Visual and familiar', 'People who do not code build and read automations.']],
    apiNote: 'A Zap can send a request to a Flow’s path, and a Flow’s web step can call a Zap’s webhook.',
    use: [['flows', 'A Flow starts from a record, a stage, a schedule or a form, so the work and the automation sit in one place.'], ['agents', 'A step that needs judgment goes to an agent, which finishes the task or marks it stuck.'], ['gate', 'A Flow that emails a customer holds the message until a person approves it.']],
    keep: 'Keep Zapier for the long tail of apps that Vyre does not package yet. Let it carry data between apps and let Vyre decide what the team does with it.',
    whyLine: 'The automation moves data. Vyre keeps the work and the yes in the same place.', why: ['rules', 'approved', 'place'], mode: 'part',
  }),
  p('make', 'automation', 'Make', {
    what: 'Builds multi-step automations on a visual canvas.', who: 'Teams that want to design branching scenarios across many apps without writing code.',
    strong: [['A canvas for complex scenarios', 'Branches, routers and data mapping are drawn and read as a picture.'], ['Many ready-made app modules', 'A wide library of connections.'], ['Scenario history', 'Each run can be inspected afterwards.']],
    apiNote: 'A scenario can call a Flow’s path, and a Flow’s web step can call a scenario’s webhook.',
    use: [['flows', 'Flows run stored steps with branches, and a person approves each version before it runs.'], ['records', 'The data a Flow works on is a record kept in the same Space, not a payload passed along.'], ['agents', 'A judgment step goes to an agent instead of a fixed rule.']],
    keep: 'Keep Make for the connections to apps Vyre does not package yet, and keep any scenario that already works.',
    whyLine: 'A scenario is cheap to build. Vyre adds an approved version and a Gate on what leaves.', why: ['rules', 'approved', 'fewer'],
  }),
  p('n8n', 'automation', 'n8n', {
    what: 'Builds workflows with nodes, hosted or on your own server.', who: 'Technical teams that want a node-based workflow tool they can run themselves.',
    host: 'Hosted by the vendor, or self-hosted.',
    strong: [['Self-hosting is an option', 'The same workflow tool can run on a server you control.'], ['Code where you need it', 'Nodes can run code, so a technical team is not boxed in.'], ['Many integration nodes', 'A broad library of connections.']],
    apiNote: 'A workflow can call a Flow’s path, and a Flow’s web step can call a workflow’s webhook.',
    use: [['flows', 'Flows run on the same server as the records, with a person approving each version.'], ['vault', 'A Flow uses a login from the Vault and a model never sees the value.'], ['agents', 'Agents are members of the Space and take tasks a Flow hands them.']],
    keep: 'If n8n already runs on your server and links your apps, keep it. Vyre sits on top as the place the work and the approvals live.',
    whyLine: 'Both can run on your server. Vyre adds the records, the agents and the Gate around the workflows.', why: ['server', 'rules', 'approved'],
  }),
  p('power-automate', 'automation', 'Microsoft Power Automate', {
    what: 'Automates tasks across Microsoft 365 and other services.', who: 'Teams that live in Microsoft 365 and want flows that react to their mail, files and Teams.',
    strong: [['Close to Microsoft 365', 'Triggers and actions for the Microsoft products a company already runs on.'], ['Custom connectors', 'A service with an API can be added as a connector.'], ['Administration in one place', 'IT can govern it with the rest of the tenant.']],
    apiNote: 'A cloud flow can call a Flow’s path through an HTTP action, and a Flow’s web step can call a flow that starts from an HTTP request.',
    use: [['flows', 'Flows start from records and stages in the Space, and a person approves each version.'], ['agents', 'An agent step handles the judgment a fixed rule cannot.'], ['gate', 'Anything that leaves waits for a person’s yes.']],
    keep: 'Keep Power Automate for work that lives inside Microsoft 365. Vyre handles the records, agent work and approvals around it.',
    whyLine: 'The Microsoft flows keep reacting to Microsoft events. Vyre takes the work from there.', why: ['rules', 'place', 'approved'],
  }),

  // Work management
  p('notion', 'work', 'Notion', {
    what: 'A workspace for notes, documents, databases and tasks.', who: 'Teams that want pages, wikis and databases in one flexible workspace.',
    strong: [['Flexible pages and databases', 'Notes, wikis and tables share one editor.'], ['Easy to shape', 'People build their own templates and views.'], ['Familiar to many people', 'New teammates often know it already.']],
    apiNote: 'Notion publishes an API for pages and databases.',
    use: [['records', 'Records of any type you define, linked in any web, with boards, calendars and dashboards.'], ['tasks', 'Tasks and Playbooks hold the stages of each kind of job and who does each.'], ['agents', 'An agent takes a task and works in the project, instead of only answering in a page.']],
    keep: 'Keep Notion for the wiki and long-form writing if your team likes it there. Let Vyre hold the records, tasks and agent work.',
    whyLine: 'A page records what happened. In Vyre the agent does the next step as well.', why: ['agents', 'place', 'fewer'],
  }),
  p('clickup', 'work', 'ClickUp', {
    what: 'Plans and tracks tasks, docs and goals.', who: 'Teams that want tasks, docs and dashboards in one configurable tool.',
    strong: [['Many views of the same tasks', 'List, board, calendar and timeline views.'], ['Configurable', 'Statuses, fields and automations can be set to the team’s way of working.'], ['Docs beside tasks', 'Written material sits near the work.']],
    apiNote: 'ClickUp publishes an API.',
    use: [['tasks', 'Tasks assigned to people or agents, and Playbooks for each kind of job.'], ['records', 'The clients, jobs and cases the tasks are about, linked to them.'], ['flows', 'Flows do the actions between stages, and a person approves each version.']],
    keep: 'Keep ClickUp if other teams depend on it. A Flow can read or update it where its API allows.',
    whyLine: 'The board shows status. Vyre adds agents that take the task and a Gate on what goes out.', why: ['agents', 'place', 'fewer'],
  }),
  p('asana', 'work', 'Asana', {
    what: 'Plans projects and tracks who does what by when.', who: 'Teams that coordinate projects across people and departments.',
    strong: [['Clear ownership', 'Each task has an owner and a due date.'], ['Timelines and portfolios', 'Managers can see work across projects.'], ['Rules and forms', 'Built-in automations and intake forms.']],
    apiNote: 'Asana publishes an API.',
    use: [['tasks', 'Tasks have an owner who is a person or an agent, with Needs you for what is waiting.'], ['records', 'Clients and projects are records the tasks link to.'], ['flows', 'Flows move work between stages on stored steps.']],
    keep: 'Keep Asana where several departments already plan in it. Vyre can read it through a Flow and do the work behind each task.',
    whyLine: 'Asana shows who owns a task. In Vyre the owner can be an agent that does it.', why: ['agents', 'rules', 'place'],
  }),
  p('monday', 'work', 'Monday.com', {
    what: 'A visual work platform of boards, dashboards and automations.', who: 'Teams that run work on colourful boards and want dashboards on top.',
    strong: [['Boards that anyone can read', 'Status columns and views are quick to learn.'], ['Dashboards', 'Charts and summaries across boards.'], ['Ready-made templates', 'Starting points for common kinds of work.']],
    apiNote: 'Monday.com publishes an API.',
    use: [['records', 'Boards by stage, calendars and dashboards over any record type you define.'], ['tasks', 'Playbooks give each kind of job its stages and owners.'], ['agents', 'Agents take items and finish them.']],
    keep: 'Keep Monday.com for cross-team boards. A Flow can update it where its API allows.',
    whyLine: 'The board stays readable. The work behind it is done by people and agents in one Space.', why: ['place', 'agents', 'fewer'],
  }),
  p('airtable', 'work', 'Airtable', {
    role: 'lists and boards',
    what: 'Relational databases with views, forms and automations.', who: 'Teams that keep structured data in tables and build their own apps on it.',
    strong: [['Spreadsheet feel, database power', 'Linked tables that non-developers can shape.'], ['Views and forms', 'Grid, kanban, calendar and gallery over one table.'], ['Interfaces', 'Custom screens for the people who use the data.']],
    apiNote: 'Airtable publishes a web API.',
    use: [['records', 'Record types and fields in your own words, linked to each other, with imports from Excel and CSV.'], ['flows', 'Flows start when a record changes or enters a stage.'], ['agents', 'Agents read and update the records under a role, with sealed fields kept from them.']],
    keep: 'A team that only keeps lists and boards in Airtable can move them into Records. Keep Airtable for bases other systems depend on.',
    whyLine: 'The table is the same idea. In Vyre the agents and the approvals sit next to it.', why: ['place', 'server', 'fewer'], mode: 'whole',
  }),
  p('trello', 'work', 'Trello', {
    role: 'a simple board',
    what: 'Kanban boards with cards and lists.', who: 'Small teams that want a simple board and little setup.',
    strong: [['Simple to start', 'A board and cards, with no setup.'], ['Easy to share', 'Clients and teammates grasp it quickly.'], ['Power-Ups', 'Extra features can be added to a board.']],
    apiNote: 'Trello publishes a REST API.',
    use: [['records', 'Boards by stage over any record type, with calendars and dashboards.'], ['tasks', 'Tasks go to a person or an agent and show up under Needs you when stuck.'], ['flows', 'Flows move a card on when a step finishes.']],
    keep: 'A team that only needs a board can run it in Vyre and drop the seat. Keep Trello for boards shared with people outside your Space.',
    whyLine: 'The board is still a board. The cards now have agents and an approval behind them.', why: ['fewer', 'agents', 'place'], mode: 'whole',
  }),

  // CRM and client management
  p('hubspot', 'crm', 'HubSpot', {
    what: 'A CRM with marketing, sales and service tools.', who: 'Teams that run marketing, sales and service from one platform.',
    strong: [['One platform for the funnel', 'Marketing, sales and service data sit together.'], ['A large ecosystem', 'Integrations, partners and training.'], ['Reporting', 'Dashboards across the pipeline.']],
    apiNote: 'HubSpot publishes APIs.',
    use: [['records', 'Contacts, organizations and deals as records you shape, with boards by stage.'], ['agents', 'An agent reads a new enquiry, drafts a reply from your price list and stops for a person.'], ['docs', 'Proposals and engagement letters filled from the record.']],
    keep: 'Keep HubSpot for email marketing, forms on the web and ad reporting. Let Vyre do the follow-up work and the approvals around it.',
    whyLine: 'The CRM remembers the contact. Vyre has the agent write the follow-up and waits for your yes.', why: ['agents', 'approved', 'place'],
  }),
  p('salesforce', 'crm', 'Salesforce', {
    what: 'A CRM and platform for sales, service and custom apps.', who: 'Larger sales and service organisations that build on a configurable platform.',
    strong: [['A deep platform', 'Objects, workflows and apps can be built on it.'], ['A broad ecosystem', 'A large partner and app marketplace.'], ['Enterprise administration', 'Roles, audit and governance for big teams.']],
    apiNote: 'Salesforce publishes REST and other APIs.',
    use: [['records', 'Working records and stages for a team that does not need the whole platform.'], ['agents', 'Agents that prepare the follow-up from a record.'], ['flows', 'Flows with an approved version for each repeated step.']],
    keep: 'Salesforce is a platform, and Vyre does not replace it for an organisation built on it. Vyre works beside it as the place where agents prepare the work.',
    whyLine: 'Keep the system of record. Add a place where agents do the preparation and a person approves.', why: ['agents', 'approved', 'rules'], mode: 'with',
  }),
  p('pipedrive', 'crm', 'Pipedrive', {
    role: 'a simple pipeline',
    what: 'A sales CRM built around the pipeline.', who: 'Sales teams that want a pipeline of deals and clear next activities.',
    strong: [['Pipeline first', 'Deals move across visible stages.'], ['Easy to adopt', 'Sales teams pick it up quickly.'], ['Activity reminders', 'Next steps stay in front of the rep.']],
    apiNote: 'Pipedrive publishes an API.',
    use: [['records', 'Deals as a record type with boards by stage.'], ['tasks', 'Follow-up tasks go to a person or an agent.'], ['flows', 'A Flow acts when a deal enters a stage.']],
    keep: 'A team that uses Pipedrive for a simple pipeline can run it in Vyre. Keep it where your sales process depends on its own features.',
    whyLine: 'The pipeline is the same shape. The follow-up is written by an agent and approved by you.', why: ['agents', 'fewer', 'approved'], mode: 'whole',
  }),
  p('zoho-crm', 'crm', 'Zoho CRM', {
    what: 'A CRM from the Zoho suite.', who: 'Teams that run on Zoho products and want a CRM that fits in the suite.',
    strong: [['Part of a suite', 'It works with other Zoho products.'], ['Configurable', 'Modules, fields and workflows can be changed.'], ['Broad feature set', 'Sales automation, analytics and more.']],
    apiNote: 'Zoho CRM publishes an API.',
    use: [['records', 'Contacts and deals as records you shape, linked to the work.'], ['agents', 'Agents prepare replies and documents from a record.'], ['flows', 'Flows with a person’s approval on each version.']],
    keep: 'Keep Zoho for the other products in the suite. Vyre can be extended by integrating your Zoho stack, where the vendor provides an API.',
    whyLine: 'The CRM can stay. Vyre adds agents and a Gate to what you do with it.', why: ['agents', 'approved', 'place'],
  }),
  p('gohighlevel', 'crm', 'GoHighLevel', {
    what: 'A marketing and CRM platform used by agencies and local businesses.', who: 'Agencies and small businesses that want funnels, messaging and a CRM in one platform.',
    strong: [['Funnels and messaging in one place', 'Pages, texts, email and calls sit with the contacts.'], ['Built for agencies', 'Accounts can be set up for many clients.'], ['Automations', 'Workflows start from contact events.']],
    apiNote: 'GoHighLevel publishes an API.',
    use: [['records', 'Contacts, opportunities and projects as records you shape.'], ['sites', 'Sites put a built page online after one yes.'], ['agents', 'Agents read an enquiry and draft the reply for approval.']],
    keep: 'Keep GoHighLevel for sending texts, phone numbers and marketing funnels, which Vyre does not provide. Vyre can read from it and prepare the work.',
    whyLine: 'The platform sends the campaign. Vyre has agents do the preparation and holds each send for approval.', why: ['agents', 'approved', 'rules'],
  }),

  // Practice management
  p('clio', 'practice', 'Clio', {
    what: 'Practice management software for law firms.', who: 'Law firms that want matters, time, billing and client records in one system.',
    strong: [['Built for legal practice', 'Matters, time entries and billing match how firms work.'], ['A system of record', 'Clients, matters and communications in one place.'], ['A large ecosystem', 'Integrations and partners.']],
    apiNote: 'Clio publishes an API.',
    use: [['agents', 'Agents prepare intake, drafts and reminders from a record.'], ['docs', 'Your own Word templates filled from a record, with signing for people who have no account.'], ['gate', 'Nothing goes to a client until a person approves the exact words.']],
    keep: 'Vyre does not replace Clio’s billing or its role as the record of the practice. Keep it, and let Vyre do the preparation around it.',
    whyLine: 'The practice record stays where it is. The work around it moves faster.', why: ['agents', 'approved', 'server'], mode: 'with',
  }),
  p('mycase', 'practice', 'MyCase', {
    what: 'Practice management software for law firms.', who: 'Smaller law firms that want cases, billing and client communication together.',
    api: false,
    strong: [['Built for legal practice', 'Case management, billing and a client portal.'], ['One system for the firm', 'Cases, contacts and communications together.'], ['Vendor support', 'The vendor runs and updates it.']],
    use: [['agents', 'Agents prepare intake, drafts and reminders.'], ['docs', 'Documents from your templates, and signing with no account.'], ['gate', 'Client messages wait for a person’s yes.']],
    keep: 'Keep MyCase for billing and as the case record. Vyre does the preparation around it.',
    whyLine: 'The case record stays in place. The drafting and follow-up are done by agents.', why: ['agents', 'approved', 'rules'], mode: 'with',
  }),
  p('practicepanther', 'practice', 'PracticePanther', {
    what: 'Practice management software for law firms.', who: 'Law firms that want matters, time and billing in a hosted system.',
    strong: [['Built for legal work', 'Matters, time tracking and billing.'], ['Hosted for you', 'The vendor runs and updates it.'], ['Integrations', 'It connects to other products.']],
    apiNote: 'PracticePanther publishes an API.',
    use: [['agents', 'Agents prepare drafts, intake and reminders from a record.'], ['docs', 'Your Word templates filled from a record, with signing.'], ['flows', 'Flows with an approved version for each repeated step.']],
    keep: 'Keep PracticePanther for billing and the matter record. Vyre works with it where its API allows.',
    whyLine: 'The matter stays in the practice system. Vyre does the preparation and holds each send.', why: ['agents', 'approved', 'rules'], mode: 'with',
  }),
  p('lawmatics', 'practice', 'Lawmatics', {
    what: 'Client intake and marketing automation for law firms.', who: 'Law firms that want intake, CRM and follow-up automation.',
    strong: [['Intake and follow-up', 'Forms, pipelines and automated outreach for prospects.'], ['Built for law firms', 'Terms and stages match the field.'], ['Automation', 'Workflows from prospect events.']],
    apiNote: 'Lawmatics publishes an API.',
    use: [['records', 'Prospects and matters as records, with boards by stage.'], ['agents', 'An agent reads a new enquiry and drafts the reply for approval.'], ['flows', 'Flows react to a new record or stage.']],
    keep: 'Keep Lawmatics for its intake forms and campaigns if the firm relies on them. Vyre can read from it and prepare the work.',
    whyLine: 'The intake form stays. Vyre does the reading, drafting and checking that follow it.', why: ['agents', 'approved', 'place'],
  }),
  p('karbon', 'practice', 'Karbon', {
    what: 'Practice management software for accounting firms.', who: 'Accounting firms that want work, email and team collaboration in one place.',
    strong: [['Built for accounting practice', 'Work items, recurring jobs and team views.'], ['Email beside the work', 'Messages tie to the job they concern.'], ['Visibility across the team', 'Managers see work by person and status.']],
    apiNote: 'Karbon publishes an API.',
    use: [['tasks', 'Playbooks list the stages and tasks of each kind of engagement and who does each.'], ['agents', 'Agents prepare checklists, requests and summaries.'], ['docs', 'Engagement letters filled from a record and sent for signature.']],
    keep: 'Keep Karbon as the practice system. Vyre works with it where its API allows and does the preparation around it.',
    whyLine: 'The firm keeps its workflow tool. The routine preparation moves to agents.', why: ['agents', 'rules', 'approved'], mode: 'with',
  }),
  p('taxdome', 'practice', 'TaxDome', {
    what: 'Practice management with a client portal for accounting and tax firms.', who: 'Accounting and tax firms that want a client portal, documents and billing together.',
    api: false,
    strong: [['A client portal', 'Clients upload documents and sign in one place.'], ['Built for the field', 'Workflows and templates for accounting and tax work.'], ['Everything in one system', 'CRM, documents and billing together.']],
    use: [['docs', 'Your own Word templates filled from a record, with signing for people who have no account.'], ['agents', 'Agents prepare requests, reminders and summaries.'], ['tasks', 'Playbooks for each kind of engagement.']],
    keep: 'Keep TaxDome for its client portal and billing. Vyre does the preparation around it.',
    whyLine: 'The portal stays where clients know it. The routine work behind it is done by agents.', why: ['agents', 'approved', 'rules'], mode: 'with',
  }),
  p('canopy', 'practice', 'Canopy', {
    what: 'Practice management software for tax and accounting firms.', who: 'Tax and accounting firms that want clients, documents and billing in one system.',
    api: false,
    strong: [['Built for tax and accounting', 'Client management, documents and billing.'], ['A client portal', 'Documents shared and collected in one place.'], ['Hosted for you', 'The vendor runs and updates it.']],
    use: [['docs', 'Documents from your templates, and signing with no account.'], ['agents', 'Agents prepare requests, reminders and summaries.'], ['tasks', 'Playbooks for each kind of engagement.']],
    keep: 'Keep Canopy as the practice system. Vyre does the preparation around it.',
    whyLine: 'The practice system stays. Agents take the preparation and the follow-up.', why: ['agents', 'approved', 'rules'], mode: 'with',
  }),

  // Documents and signing
  p('docusign', 'docs', 'DocuSign', {
    what: 'Electronic signature and agreement management.', who: 'Organisations that need signatures with an established legal and compliance footprint.',
    strong: [['An established standard', 'Many counterparties already know it.'], ['Signing features', 'Routing, fields and audit trails for agreements.'], ['Wide integrations', 'It connects to many products.']],
    apiNote: 'DocuSign publishes an eSignature API.',
    use: [['docs', 'Vyre fills your own Word template from a record and sends it for signature. The signer needs no account and the signed copy files back on the record.'], ['gate', 'Sending is a held act: a person reads the email and says yes once.'], ['records', 'The signature status lives on the Document record.']],
    keep: 'For routine engagement letters and agreements, Vyre’s signing is enough. Keep DocuSign where a counterparty requires it.',
    whyLine: 'The document is made from your template and tied to the record, so nobody retypes it or chases the status.', why: ['place', 'approved', 'fewer'],
  }),
  p('pandadoc', 'docs', 'PandaDoc', {
    what: 'Document creation, proposals and e-signature.', who: 'Sales and service teams that send proposals and quotes and want them signed.',
    strong: [['Proposal templates', 'Designed documents with content blocks.'], ['Signing and tracking', 'See when a document is opened and signed.'], ['CRM connections', 'It links to common CRMs.']],
    apiNote: 'PandaDoc publishes an API.',
    use: [['docs', 'Your Word templates filled from a record, with signing for people who have no account.'], ['agents', 'An agent drafts the covering message from the record.'], ['gate', 'The send waits for a person’s yes.']],
    keep: 'Keep PandaDoc if you rely on its designed proposal layouts. Vyre covers template-based documents and signing.',
    whyLine: 'The proposal is filled from the record and the send is approved before it leaves.', why: ['place', 'approved', 'fewer'],
  }),
  p('dropbox-sign', 'docs', 'Dropbox Sign', {
    role: 'routine document signing',
    what: 'Electronic signatures from Dropbox.', who: 'Teams that want a simple way to send and sign documents.',
    strong: [['Simple to use', 'Send a document and collect a signature.'], ['Part of Dropbox', 'It sits beside the files many teams already keep there.'], ['Templates', 'Reuse a document for repeated signing.']],
    apiNote: 'Dropbox Sign publishes an API.',
    use: [['docs', 'Send a template for signature from a record, with no account needed by the signer.'], ['records', 'Signed copies file on the record.'], ['gate', 'A person approves the send.']],
    keep: 'A team that signs routine documents can use Vyre’s signing instead. Keep Dropbox Sign where a counterparty asks for it.',
    whyLine: 'Signing happens where the record is, so there is one fewer tool to log into.', why: ['fewer', 'place', 'approved'], mode: 'whole',
  }),

  // Passwords
  p('1password', 'passwords', '1Password', {
    what: 'A password manager for people, families and businesses.', who: 'People and companies that want every login in a manager with browser and phone apps.',
    strong: [['Apps everywhere', 'Browser extensions and apps on every device.'], ['Sharing and vaults', 'Teams share logins by vault.'], ['Developer tools', 'A command line and secrets tooling for builders.']],
    apiNote: '1Password publishes developer tools for reading secrets.',
    use: [['vault', 'The Vault seals passwords, keys, tokens and cards, and hands them to an agent or Flow as use only, so a model never reads the value.'], ['gate', 'A held send that uses a Vault credential waits for a yes.']],
    keep: 'Vyre’s Vault is built for the credentials your agents and Flows use. Keep 1Password for the logins your people fill in on the web every day.',
    whyLine: 'An agent can sign in without being able to read the password.', why: ['server', 'approved', 'place'], mode: 'with',
  }),
  p('bitwarden', 'passwords', 'Bitwarden', {
    what: 'An open-source password manager.', who: 'People and teams that want a password manager they can self-host.',
    host: 'Hosted by the vendor, or self-hosted.',
    strong: [['Open source', 'The code is public.'], ['Self-hosting is an option', 'Teams can run it on their own server.'], ['Apps and extensions', 'Browser extensions and mobile apps.']],
    apiNote: 'Bitwarden publishes a command line tool and an API.',
    use: [['vault', 'The Vault seals the credentials your agents and Flows use, and hands them over as use only.'], ['gate', 'A held send that uses a credential waits for a yes.']],
    keep: 'Keep Bitwarden for the logins your people fill in on the web. The Vault covers what agents and Flows use.',
    whyLine: 'Both can run on your server. Vyre’s Vault is made for credentials an agent uses without reading.', why: ['server', 'approved', 'place'], mode: 'with',
  }),

  // AI
  p('chatgpt-team', 'ai', 'ChatGPT for teams', {
    what: 'A shared ChatGPT workspace for a team.', who: 'Teams that want OpenAI’s assistant with shared workspace controls.',
    strong: [['OpenAI’s models and features', 'The people who build the model build the assistant.'], ['Nothing to run', 'Sign up and invite the team.'], ['Polished apps', 'Web, desktop and phone.']],
    apiNote: 'OpenAI publishes an API, and Vyre runs Codex through your own sign-in or key.',
    use: [['chat', 'Chats where people and agents from any model take part together.'], ['agents', 'Agents with a role and a reach, taking tasks.'], ['records', 'The records, tasks and files the chat is about, in the same Space.']],
    keep: 'Keep ChatGPT for thinking and drafting if your team likes it. Vyre uses your own accounts as models and is where the work happens.',
    whyLine: 'The assistant answers. In Vyre the agent also acts on the records, with a yes before anything leaves.', why: ['place', 'agents', 'approved', 'server'], mode: 'with',
  }),
  p('claude-teams', 'ai', 'Claude for teams', {
    what: 'A shared Claude workspace for a team.', who: 'Teams that want Anthropic’s assistant with shared projects and admin controls.',
    strong: [['Anthropic’s models and features', 'The people who build the model build the assistant.'], ['Nothing to run', 'Sign up and invite the team.'], ['Projects and connectors', 'Shared context and connections to common apps.']],
    apiNote: 'Anthropic publishes an API, and Vyre works with Claude through your own accounts or keys.',
    use: [['chat', 'Chats where people and agents from any model take part together.'], ['agents', 'Agents with a role and a reach, taking tasks.'], ['records', 'The records, tasks and files the chat is about, in the same Space.']],
    keep: 'Vyre runs Claude through your own accounts. Keep the Claude workspace for individual thinking and let Vyre hold the team’s shared work.',
    whyLine: 'Claude does the thinking, and Vyre gives it the records, the task and the approval.', why: ['place', 'agents', 'approved', 'server'], mode: 'with',
  }),
  p('copilot', 'ai', 'Microsoft Copilot', {
    what: 'An AI assistant built into Microsoft 365.', who: 'Organisations that live in Microsoft 365 and want an assistant inside Word, Outlook and Teams.',
    strong: [['Inside the tools people use', 'It works in the Microsoft apps they already have open.'], ['Tenant administration', 'IT governs it with the rest of Microsoft 365.'], ['Microsoft Graph data', 'It can use the mail, files and calendar a tenant holds.']],
    apiNote: 'Microsoft publishes extensibility options for Copilot and APIs through Microsoft Graph.',
    use: [['agents', 'Agents with a role and a reach that take tasks and finish them.'], ['records', 'Records, tasks and files in a Space you own.'], ['flows', 'Flows with a person’s approval on each version.']],
    keep: 'Vyre does not replace Copilot in Word, Outlook or Teams. Use Copilot there and Vyre for the work that spans people, records and approvals.',
    whyLine: 'Copilot helps in the document. Vyre keeps the work around it and holds what leaves.', why: ['place', 'approved', 'server'], mode: 'with',
  }),

  // Websites
  p('webflow', 'sites', 'Webflow', {
    what: 'A visual website builder and host.', who: 'Designers and marketing teams that want to build and publish custom sites visually.',
    strong: [['Design control', 'Layout and style are built visually, close to the code.'], ['A CMS', 'Content collections for pages and posts.'], ['Hosting included', 'The vendor serves the site.']],
    apiNote: 'Webflow publishes a Data API for sites and content.',
    use: [['sites', 'Sites put a folder of files, a repo or a built site online. An agent builds it, previews it privately and asks for one yes.'], ['gate', 'Going live is a held act with a version you can roll back.'], ['vault', 'A site gets only the secrets you grant it, one by one.']],
    keep: 'Keep Webflow if your designers build in its editor. Vyre publishes sites that agents or developers build as files.',
    whyLine: 'An agent builds and previews the site, and nothing is public until you say yes.', why: ['agents', 'approved', 'server'],
  }),
  p('squarespace', 'sites', 'Squarespace', {
    what: 'A website builder with hosting and templates.', who: 'Small businesses and individuals who want a good-looking site without code.',
    api: false,
    strong: [['Templates with good design', 'A site looks finished quickly.'], ['Everything included', 'Hosting, domain options and commerce.'], ['Simple editing', 'No code needed.']],
    use: [['sites', 'Publish a site that an agent or developer built, with its own domain, a private preview and rollback.'], ['gate', 'Going live is a held act.'], ['vault', 'A site gets only the secrets you grant it, one by one.']],
    keep: 'Keep Squarespace if the editor suits your team. Vyre fits a site built as files and published from your Space.',
    whyLine: 'The site is built, previewed and published from the same place as the rest of the work.', why: ['fewer', 'approved', 'agents'],
  }),
  p('wix', 'sites', 'Wix', {
    what: 'A website builder with hosting.', who: 'Small businesses and individuals who want to build a site with an editor and add features from an app market.',
    strong: [['An editor for everyone', 'Drag-and-drop editing.'], ['An app market', 'Add features without code.'], ['Hosting included', 'The vendor serves the site.']],
    apiNote: 'Wix publishes developer APIs.',
    use: [['sites', 'Publish a site that an agent or developer built, with its own domain, a private preview and rollback.'], ['gate', 'Going live is a held act.'], ['vault', 'A site gets only the secrets you grant it, one by one.']],
    keep: 'Keep Wix if the editor suits your team. Vyre fits a site built as files and published from your Space.',
    whyLine: 'The site is built, previewed and published from the same place as the rest of the work.', why: ['fewer', 'approved', 'agents'],
  }),

  // Communications
  p('ringcentral', 'comms', 'RingCentral', {
    what: 'Phone, messaging and video for business.', who: 'Businesses that run their phone lines, messages and meetings on one communications platform.',
    strong: [['A business phone system', 'Numbers, extensions and call handling.'], ['Messaging and video together', 'One platform for calls, chat and meetings.'], ['Carrier-grade service', 'Run by the vendor.']],
    apiNote: 'RingCentral publishes a developer API.',
    use: [['records', 'A Flow can turn what comes from RingCentral into a record, where its API allows.'], ['agents', 'An agent can prepare the follow-up from it.'], ['gate', 'The reply waits for a person’s yes.']],
    keep: 'Vyre does not replace a phone system, and it does not carry calls. Keep RingCentral for telephony and connect it where its API allows.',
    whyLine: 'The phone system carries the call. Vyre turns it into a record and a task.', why: ['place', 'agents', 'approved'], mode: 'with',
  }),
  p('slack', 'comms', 'Slack', {
    what: 'Team messaging in channels and threads.', who: 'Companies that run daily conversation in channels and want apps close to it.',
    strong: [['Where many teams already talk', 'Channels, threads and huddles.'], ['A large app directory', 'Many products post into Slack.'], ['Search across conversations', 'History is easy to find.']],
    apiNote: 'Slack publishes a Web API and incoming webhooks.',
    use: [['chat', 'Chats between people and agents in a Space, with a Needs you chip when one waits.'], ['tasks', 'Tasks go to a person or an agent and appear under Needs you when stuck.'], ['records', 'The chat sits beside the records it is about.']],
    keep: 'Keep Slack for company-wide conversation. Vyre’s chat is for work with agents on records and tasks. A Flow can post to Slack where its API allows.',
    whyLine: 'Slack is where the company talks. Vyre is where the agent and the record are.', why: ['place', 'agents', 'approved'], mode: 'with',
  }),

  // Accounting
  p('quickbooks', 'accounting', 'QuickBooks', {
    what: 'Accounting software for small businesses.', who: 'Small businesses that want bookkeeping, invoicing and reports.',
    strong: [['Standard in bookkeeping', 'Many accountants and tools support it.'], ['Invoicing and reports', 'Core small-business accounting.'], ['A large ecosystem', 'Apps connect to it.']],
    apiNote: 'Intuit publishes an API for QuickBooks Online.',
    use: [['records', 'Clients and engagements as records, with the data a bill needs.'], ['agents', 'Agents prepare an invoice request or a reminder from the record.'], ['gate', 'A payment or a send waits for a person’s yes.']],
    keep: 'Vyre does not replace your accounting ledger. Keep QuickBooks as the books, and have Vyre prepare what goes into it.',
    whyLine: 'The ledger stays accurate. The preparation upstream moves to agents and gets approved.', why: ['agents', 'approved', 'rules'], mode: 'with',
  }),
  p('xero', 'accounting', 'Xero', {
    what: 'Cloud accounting software for small businesses.', who: 'Small businesses and their advisers that want online bookkeeping and invoicing.',
    strong: [['Online accounting', 'Bank feeds, invoicing and reports.'], ['Adviser access', 'Accountants work in the same books.'], ['An app marketplace', 'Other tools connect to it.']],
    apiNote: 'Xero publishes an API.',
    use: [['records', 'Clients and engagements as records, with the data a bill needs.'], ['agents', 'Agents prepare an invoice request or a reminder from the record.'], ['gate', 'A payment or a send waits for a person’s yes.']],
    keep: 'Vyre does not replace your accounting ledger. Keep Xero as the books, and have Vyre prepare what goes into it.',
    whyLine: 'The ledger stays accurate. The preparation upstream moves to agents and gets approved.', why: ['agents', 'approved', 'rules'], mode: 'with',
  }),
];

export { TODAY, NEXT, NOAPI };
