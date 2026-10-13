// The "Give this to your AI agent" prompt and the /map/ page (vyre.run). One source: the prompt text below is also
// docs/for-agents/PROMPT.md (test/site-agent-prompt.test.js holds the two equal), the home block and /map/ render it,
// and the form on /map/ (site/v2.js) builds a tailored copy from the same text. No network calls, no storage.

const SITE = 'https://vyre.run';

export const START_HERE_URL = `${SITE}/agenthome.md`;

export const PROMPT = `Read ${START_HERE_URL} and follow it to show me how my business would run on Vyre, the agentic command center for AI-native teams. Ask me what you need.`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Styles for the prompt box and the map page. Inline so the shared stylesheet stays untouched by this lane.
const STYLE = `<style>
.pbox{position:relative;border:1px solid var(--line);background:var(--panel);margin:0}
.pbox-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--line)}
.pbox-bar .lbl{margin:0}
.pbox pre{margin:0;padding:16px 18px;font:400 13px/1.55 var(--mono);color:var(--ink-2);white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}
.pbox.tall pre{max-height:520px}
.pbox button.cp{font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--bg);background:var(--ink);border:0;border-radius:4px;padding:9px 14px;cursor:pointer}
.pbox button.cp:hover{background:var(--accent)}
.ap-grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:clamp(24px,4vw,56px);align-items:start}
@media(max-width:900px){.ap-grid{grid-template-columns:1fr}}
.ap-steps{list-style:none;margin:18px 0 0;padding:0;counter-reset:s;display:grid;gap:10px}
.ap-steps li{counter-increment:s;display:grid;grid-template-columns:28px 1fr;gap:10px;font-size:15px;color:var(--ink-2)}
.ap-steps li::before{content:counter(s);font:500 11px/26px var(--mono);color:var(--accent);border:1px solid var(--line-2);text-align:center;height:26px}
.ap-steps b{color:var(--ink)}
.mapper{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:clamp(24px,4vw,48px);align-items:start}
@media(max-width:960px){.mapper{grid-template-columns:1fr}}
.mform{border:1px solid var(--line);background:var(--panel);padding:20px}
.mform fieldset{border:0;margin:0 0 20px;padding:0;min-width:0}
.mform legend{font:500 11px/1.4 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);padding:0;margin-bottom:8px}
.mform select,.mform input[type=text]{font:400 15px var(--sans);color:var(--ink);background:var(--bg);border:1px solid var(--line-2);border-radius:4px;padding:9px 10px;width:100%;max-width:100%}
.mrow{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:480px){.mrow{grid-template-columns:1fr}}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chips button{font:400 13px var(--sans);color:var(--ink-2);background:transparent;border:1px solid var(--line-2);border-radius:999px;padding:5px 11px;cursor:pointer}
.chips button[aria-pressed=true]{color:var(--ink);background:var(--accent-wash);border-color:var(--accent)}
.addrow{display:flex;gap:6px}
.addrow button{font:500 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink);background:transparent;border:1px solid var(--line-2);border-radius:4px;padding:0 12px;cursor:pointer}
.sketch{border:1px solid var(--line);background:var(--panel);padding:20px;min-width:0}
.sketch h3{font:500 11px/1.4 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--accent);margin:22px 0 8px}
.sketch h3:first-child{margin-top:0}
.sk-sum{font-size:15px;color:var(--ink-2);margin:0 0 4px}
.tblw{overflow-x:auto;max-width:100%}
.tblw table{border-collapse:collapse;width:100%;font-size:13.5px}
.tblw th{font:500 10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);text-align:left;padding:6px 10px 6px 0;border-bottom:1px solid var(--line-2);white-space:nowrap}
.tblw td{padding:8px 10px 8px 0;border-bottom:1px dashed var(--line);vertical-align:top;color:var(--ink-2)}
.tblw td:first-child{color:var(--ink);font-weight:500}
.seal{font:400 11px var(--mono);color:var(--ok)}
.next{font:500 10px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);border:1px solid var(--accent);padding:1px 5px;margin-left:4px;white-space:nowrap}
.flow{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.flow li{font-size:12.5px;color:var(--ink-2);border:1px solid var(--line);padding:3px 8px;background:var(--bg)}
.flow li.ap{border-color:var(--accent);color:var(--ink)}
.flow li.tr{background:var(--accent-wash);color:var(--ink)}
.flow li+li::before{content:"";}
.skblock{margin:0 0 14px}
.skblock p{margin:0 0 4px;font-size:14px;color:var(--ink-2)}
.skblock p b{color:var(--ink)}
.day{list-style:none;margin:28px 0 0;padding:0;display:grid;gap:0;border-left:1px solid var(--line-2);max-width:760px}
.day li{position:relative;padding:0 0 18px 22px;font-size:15px;color:var(--ink-2)}
.day li::before{content:"";position:absolute;left:-4px;top:7px;width:7px;height:7px;background:var(--accent)}
.day time{font:500 12px var(--mono);color:var(--ink-3);display:block;margin-bottom:2px}
.day b{color:var(--ink)}
.conn{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0;border:1px solid var(--line)}
.conn a{display:block;padding:16px 18px;text-decoration:none;border-left:1px solid var(--line);border-top:1px solid var(--line);margin:-1px 0 0 -1px;font-size:14.5px;color:var(--ink-2)}
.conn a b{display:block;color:var(--ink);font-size:15.5px;margin-bottom:2px}
.conn a:hover{background:var(--accent-wash)}
html:not(.js) .needs-js{display:none}
html.js .no-js{display:none}
@media(prefers-reduced-motion:no-preference){.sketch .tblw,.sketch .skblock{animation:apin .35s ease both}@keyframes apin{from{opacity:.4}to{opacity:1}}}
</style>`;

/** The home page block. */
export function homeBlock(MAP_URL) {
  return `${STYLE}
<section class="sec" id="agent-guide" aria-labelledby="agt-h">
  <div class="wrap">
    <div class="ap-grid">
      <div class="rv">
        <p class="lbl" id="agt-h" style="margin-bottom:14px">Give this to your AI agent</p>
        <h2 class="h2" style="font-size:clamp(28px,3.8vw,44px)">See your business <b>as an AI-native team on Vyre.</b></h2>
        <ol class="ap-steps">
          <li><span><b>Copy the prompt.</b> It is two lines. It sends your agent to a page that holds the full instructions.</span></li>
          <li><span><b>Paste it into your AI.</b> ChatGPT, Claude or any agent that can read links.</span></li>
          <li><span><b>Answer a few questions</b> about what you sell, your team, what you track and what must never go out without a yes.</span></li>
          <li><span><b>Get your business mapped:</b> members, records, Playbooks, Flows, agents and approvals. If you want it, your agent can set Vyre up for you over Vyre&rsquo;s MCP.</span></li>
        </ol>
        <p class="btn-row" style="margin-top:22px"><a class="btn btn-fill btn-sm" href="/map/">Tailor it to your business</a> <a class="btn btn-sm" href="/agenthome/">What your agent reads</a></p>
      </div>
      <div class="pbox rv">
        <div class="pbox-bar"><span class="lbl">Prompt &middot; plain text</span><button class="cp" type="button" data-copy-from="home-prompt" aria-label="Copy the prompt">Copy</button></div>
        <pre id="home-prompt" tabindex="0" style="max-height:none">${esc(PROMPT)}</pre>
      </div>
    </div>
  </div>
</section>
`;
}

// ---------- the /map/ page ----------

const THINGS = {
  Clients: ['Name, Email, Phone, Status, Owner', 'Tax ID'],
  Leads: ['Name, Source, Stage, Next step, Owner', ''],
  Engagements: ['Client, Service, Fee, Period, Status', ''],
  Matters: ['Client, Practice area, Opened, Status, Responsible person', ''],
  Projects: ['Client, Scope, Dates, Budget, Status', ''],
  Invoices: ['Client, Amount, Due date, Status', ''],
  'Filings and deadlines': ['Client, Form, Due date, Status', ''],
  Properties: ['Address, Owner, Status, Price', ''],
  Deals: ['Client, Value, Stage, Close date', ''],
  Accounts: ['Client, Custodian, Type, Opened', 'Account number'],
  Campaigns: ['Client, Channel, Budget, Dates, Status', ''],
  Appointments: ['Client, When, With whom, Notes', ''],
};

const WORK = {
  'New enquiry follow-up': { stages: ['Enquiry', 'Qualified', 'Consult booked', 'Proposal sent', 'Won or lost'], trigger: 'A form or a new Lead', steps: ['Find or create the contact', 'Agent drafts a reply', 'Wait 2 days', 'Assign a follow-up task'], gate: 'Reply email', agent: ['Intake helper', 'drafts replies from the enquiry; reads Leads only'] },
  'Client onboarding': { stages: ['Welcome', 'Collect details', 'Documents signed', 'Set up', 'Kick-off done'], trigger: 'A record moves to Won', steps: ['Start a project from the Playbook', 'Fill the engagement letter', 'Send it for signature', 'Wait for the signature', 'Create the setup tasks'], gate: 'Engagement letter', agent: ['Onboarding helper', 'fills the letter and tracks the checklist; sees the new client only'] },
  'Recurring deliverables': { stages: ['Prepare', 'Review', 'Deliver', 'Follow up'], trigger: 'A schedule, in business hours', steps: ['For each active client, start a project', 'Agent drafts the deliverable', 'Ask the reviewer', 'Send'], gate: 'Deliverable to the client', agent: ['Drafting agent', 'prepares the first draft from the client record; cannot send'] },
  'Document requests and chasing': { stages: ['Requested', 'Partly received', 'Complete'], trigger: 'A schedule, weekly', steps: ['Find clients with items missing', 'Agent drafts the request', 'Wait 3 days', 'Remind once, then assign a person'], gate: 'Request email', agent: ['Chaser', 'lists what is missing per client; drafts, never sends'] },
  'Invoicing and payment chasing': { stages: ['To invoice', 'Sent', 'Paid', 'Overdue'], trigger: 'A job or stage reaches Done', steps: ['Fill the invoice from the record', 'Ask the approver', 'Send', 'Wait 3 days', 'If unpaid, assign a task'], gate: 'Invoice email', agent: ['Billing helper', 'prepares invoices from finished work; sees Invoices and the linked client'] },
  'Document signing': { stages: ['Drafted', 'Sent to sign', 'Signed', 'Filed'], trigger: 'A record reaches a stage', steps: ['Fill the Word template from the record', 'Send for signature', 'Wait for the signer', 'File the signed copy on the record'], gate: 'Document sent for signature', agent: ['Document agent', 'fills templates from records; a model never rewrites the document'] },
  'Reports and updates': { stages: ['Collect', 'Draft', 'Approve', 'Send'], trigger: 'A schedule, weekly', steps: ['Agent reads the week\'s records', 'Agent drafts the summary', 'Ask a person', 'Send'], gate: 'Report to the client', agent: ['Reporter', 'reads records and drafts the summary; cannot send'] },
  'Deadlines and reminders': { stages: ['Upcoming', 'Due soon', 'Done'], trigger: 'A date on a record comes near', steps: ['Wait until 7 days before', 'Assign a task to the owner', 'Wait until 1 day before', 'Remind'], gate: 'Reminder to the client', agent: ['Deadline watcher', 'watches dates and raises tasks; reads Deadlines only'] },
};

const INDUSTRIES = {
  accounting: { name: 'Accounting and tax', roles: ['Partner', 'Manager', 'Senior accountant', 'Bookkeeper', 'Admin'], things: ['Clients', 'Engagements', 'Filings and deadlines', 'Invoices'], work: ['Client onboarding', 'Recurring deliverables', 'Document requests and chasing', 'Invoicing and payment chasing'], tools: ['QuickBooks', 'Xero', 'Google Workspace', 'Microsoft 365', 'Stripe'], nevers: ['Client email', 'Filings and submissions', 'Payments and refunds'] },
  law: { name: 'Law', roles: ['Partner', 'Associate', 'Paralegal', 'Intake coordinator', 'Office manager'], things: ['Clients', 'Matters', 'Leads', 'Invoices'], work: ['New enquiry follow-up', 'Client onboarding', 'Document signing', 'Invoicing and payment chasing'], tools: ['Clio', 'Lawmatics', 'GoHighLevel', 'Google Workspace', 'Microsoft 365'], nevers: ['Client email', 'Anything signed', 'Filings and submissions'] },
  agency: { name: 'Marketing agency', roles: ['Owner', 'Account manager', 'Strategist', 'Designer', 'Operations lead'], things: ['Clients', 'Projects', 'Campaigns', 'Leads', 'Invoices'], work: ['New enquiry follow-up', 'Client onboarding', 'Reports and updates', 'Invoicing and payment chasing'], tools: ['HubSpot', 'Slack', 'Google Workspace', 'Stripe'], nevers: ['Client email', 'Publishing a page', 'Payments and refunds'] },
  consulting: { name: 'Consulting', roles: ['Principal', 'Consultant', 'Analyst', 'Operations lead'], things: ['Clients', 'Projects', 'Deals', 'Invoices'], work: ['New enquiry follow-up', 'Client onboarding', 'Reports and updates', 'Invoicing and payment chasing'], tools: ['Salesforce', 'Slack', 'Google Workspace', 'Microsoft 365'], nevers: ['Client email', 'Anything signed', 'Payments and refunds'] },
  realestate: { name: 'Real estate', roles: ['Broker', 'Agent', 'Transaction coordinator', 'Admin'], things: ['Clients', 'Properties', 'Deals', 'Appointments'], work: ['New enquiry follow-up', 'Document signing', 'Deadlines and reminders'], tools: ['Zoho', 'RingCentral', 'Google Workspace', 'Stripe'], nevers: ['Client email', 'Anything signed', 'Publishing a page'] },
  advice: { name: 'Financial advice', roles: ['Principal advisor', 'Associate advisor', 'Paraplanner', 'Client service'], things: ['Clients', 'Accounts', 'Appointments', 'Invoices'], work: ['Client onboarding', 'Recurring deliverables', 'Document signing', 'Deadlines and reminders'], tools: ['Microsoft 365', 'Salesforce', 'Google Workspace', 'RingCentral'], nevers: ['Client email', 'Anything signed', 'Payments and refunds'] },
  other: { name: 'Another kind of firm', roles: ['Owner', 'Manager', 'Team member'], things: ['Clients', 'Projects', 'Invoices'], work: ['New enquiry follow-up', 'Client onboarding', 'Invoicing and payment chasing'], tools: ['Google Workspace', 'Slack'], nevers: ['Client email', 'Payments and refunds'] },
};

const MORE = {
  roles: ['Owner', 'Operations lead', 'Sales lead', 'Finance lead', 'Admin'],
  things: Object.keys(THINGS),
  work: Object.keys(WORK),
  tools: ['Zoho', 'QuickBooks', 'RingCentral', 'HubSpot', 'Slack', 'Stripe', 'Dropbox', 'Google Workspace', 'Microsoft 365'],
  nevers: ['Client email', 'Payments and refunds', 'Filings and submissions', 'Anything signed', 'Publishing a page', 'Deleting records'],
};

// Integrations named on the roadmap for 0.5.2 (roadmap/0.5.2.md items 4 to 7).
const PLANNED_INTEGRATIONS = ['Clio', 'Lawmatics', 'GoHighLevel'];

const MAP_DATA = { industries: INDUSTRIES, more: MORE, things: THINGS, work: WORK, planned: PLANNED_INTEGRATIONS, sizes: ['1 to 5', '6 to 15', '16 to 50', 'More than 50'] };

const chipGroup = (cat, label, hint) => `<fieldset><legend>${label}</legend><div class="chips" data-cat="${cat}" role="group" aria-label="${label}"></div><div class="addrow"><input type="text" data-add="${cat}" placeholder="${hint}" aria-label="Add to ${label}" maxlength="60"><button type="button" data-addbtn="${cat}">Add</button></div></fieldset>`;

export const MAP_META = {
  slug: 'map', path: '/map/',
  title: 'Map your business onto Vyre',
  desc: 'Pick your industry, team, records and tools, and get a prompt that makes your own AI agent map your business onto Vyre: members, records, Playbooks, Flows and approvals.',
  ogTitle: 'Map your business.', ogSub: 'A prompt for your own AI agent, tailored to your firm.',
};

export function mapBody({ MAP_URL, REPO, eyebrow }) {
  return `${STYLE}
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Map your business</p>
    ${eyebrow('Give it to your AI agent.')}
    <h1 class="display">Map your business <b>onto Vyre.</b></h1>
    <p class="lead">Tell this page about your firm. It builds a prompt for your own AI agent and sketches what your business looks like on Vyre: people as members with roles, the things you track as record types, the work you repeat as Playbooks and Flows. Nothing you pick leaves this page.</p>
  </div>
</section>

<section class="sec" style="padding-top:48px" aria-labelledby="mapper-h">
  <div class="wrap">
    <h2 id="mapper-h" class="lbl" style="margin-bottom:22px">Your firm</h2>
    <div class="mapper" id="mapper">
      <form class="mform needs-js" id="mform" onsubmit="return false" aria-label="About your firm">
        <fieldset><legend>Industry</legend>
          <div class="mrow">
            <select id="m-industry" aria-label="Industry">${Object.entries(INDUSTRIES).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')}</select>
            <select id="m-size" aria-label="Team size">${MAP_DATA.sizes.map((s, i) => `<option${i === 1 ? ' selected' : ''}>${s}</option>`).join('')}</select>
          </div>
        </fieldset>
        ${chipGroup('roles', 'Roles on your team', 'Another role')}
        ${chipGroup('things', 'What you track', 'Something else you track')}
        ${chipGroup('work', 'Work you repeat', 'Other repeated work')}
        ${chipGroup('tools', 'Tools you use', 'Another tool')}
        ${chipGroup('nevers', 'Never goes out without a yes', 'Something else')}
      </form>
      <div class="sketch" id="sketch" aria-live="polite">
        <p class="sk-sum no-js">Turn on JavaScript to tailor the sketch. The full prompt below works as it is.</p>
      </div>
    </div>
    <script type="application/json" id="map-data">${JSON.stringify(MAP_DATA).replace(/</g, '\\u003c')}</script>
  </div>
</section>

<section class="sec" id="prompt" aria-labelledby="prompt-h">
  <div class="wrap">
    <div class="feat">
      <div class="feat-copy rv"><span class="num">Your prompt</span><h2 id="prompt-h" class="h2">Copy it. Paste it into <b>your AI.</b></h2>
        <ol class="ap-steps">
          <li><span><b>Paste</b> it into ChatGPT, Claude or any agent that can read links.</span></li>
          <li><span><b>Answer</b> its questions. Anything you picked above, it already knows.</span></li>
          <li><span><b>Read your map:</b> members, records, Playbooks, Flows, agents and approvals, in your words.</span></li>
          <li><span><b>Say yes</b> if you want it built. The agent can set Vyre up for you.</span></li>
        </ol>
        <p class="btn-row" style="margin-top:22px"><a class="btn btn-sm" href="/agenthome/">What your agent reads</a> <a class="btn btn-sm" href="${MAP_URL}">The method</a></p>
      </div>
      <div class="pbox rv">
        <div class="pbox-bar"><span class="lbl" id="out-lbl">Prompt &middot; plain text</span><button class="cp" type="button" data-copy-from="prompt-out" aria-label="Copy the prompt">Copy</button></div>
        <pre id="prompt-out" tabindex="0">${esc(PROMPT)}</pre>
      </div>
    </div>
  </div>
</section>

<section class="sec" aria-labelledby="day-h">
  <div class="wrap">
    <div class="feat">
      <div class="feat-copy rv"><span class="num">An example day</span><h2 id="day-h" class="h2">People decide. <b>Agents do the work.</b></h2>
        <p class="lead" style="margin-top:14px">Your agent writes this for your firm. Here is the shape of one day, with sample names.</p></div>
      <ul class="day rv">
        <li><time>08:10</time><b>Needs you</b> holds three things for Maya: a reply to a new enquiry, an invoice and a document for signature. Each shows its exact words.</li>
        <li><time>08:25</time>Maya approves the reply and edits one line. The Gate sends it. The invoice waits for a number she wants to check.</li>
        <li><time>10:00</time>A new client signs the engagement letter on their phone, with no account. The signed copy files on the client record and starts the onboarding Flow.</li>
        <li><time>13:30</time>The drafting agent finishes first drafts for five clients. It cannot send. Dev reviews each and says yes or sends it back with a note.</li>
        <li><time>16:45</time>An agent step cannot finish: a document is missing. It marks the task stuck with a plain reason, and the reason is at the top of Dev&rsquo;s Needs you.</li>
      </ul>
    </div>
  </div>
</section>

<section class="sec" aria-labelledby="set-h">
  <div class="wrap">
    <div class="note rv" style="max-width:52em">
      <p class="lbl" id="set-h" style="margin-bottom:8px">If you want it built</p>
      <p style="margin:0 0 10px">Your agent can set Vyre up with you, over Vyre&rsquo;s MCP. You install Vyre from <a href="/start/">the steps</a>: the app shows one install line and a code, and you run and enter them yourself. Your agent then connects: in Claude Code, <code>vyre mcp install</code> prints the line that adds Vyre&rsquo;s MCP server, and for another MCP client you name a key in Settings, under Your AI keys.</p>
      <p style="margin:0">From there your agent works through Vyre&rsquo;s tools, and Vyre&rsquo;s built-in Engineer drafts record types, Flows and Playbooks as cards that one yes from you applies. Anything that leaves your team waits at the Gate for your yes. Credentials, sign-ins and devices stay with you.</p>
    </div>
  </div>
</section>

<section class="sec" aria-labelledby="conn-h">
  <div class="wrap">
    <h2 id="conn-h" class="lbl" style="margin-bottom:18px">Connects to</h2>
    <div class="conn rv">
      <a href="/architecture/"><b>Architecture</b>How a call flows, how an agent&rsquo;s turn runs, the Gate.</a>
      <a href="/start/"><b>Get started</b>Install Vyre and pair your server.</a>
      <a href="/direction/"><b>Direction</b>What comes next, by version.</a>
      <a href="${MAP_URL}"><b>The method</b>The steps your agent follows.</a>
      <a href="${REPO}/blob/main/docs/architecture/features/records.md"><b>Records</b>Objects you shape, linked in any web.</a>
      <a href="${REPO}/blob/main/docs/architecture/features/flows.md"><b>Flows</b>Triggers, steps and approvals.</a>
      <a href="${REPO}/blob/main/docs/architecture/features/mcp-and-engineer.md"><b>MCP and the Engineer</b>How an agent connects and builds.</a>
    </div>
  </div>
</section>

<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">See your firm <b>on Vyre.</b></h2><div class="btn-row"><a class="btn btn-fill" href="#prompt">Copy the prompt</a><a class="btn" href="/start/">Set up Vyre</a></div></div></section>`;
}
