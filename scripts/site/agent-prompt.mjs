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
.flow{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.flow li{font-size:12.5px;color:var(--ink-2);border:1px solid var(--line);padding:3px 8px;background:var(--bg)}
.flow li.ap{border-color:var(--accent);color:var(--ink)}
.flow li.tr{background:var(--accent-wash);color:var(--ink)}
.next{font:500 10px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);border:1px solid var(--accent);padding:1px 5px;white-space:nowrap}
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
  'New enquiry follow-up': { stages: ['Enquiry', 'Qualified', 'Consult booked', 'Proposal sent', 'Won or lost'], trigger: 'A form or a new Lead', steps: ['Find or create the contact', 'Agent drafts a reply', 'Wait 2 days', 'Assign a follow-up task'], gate: 'Reply email', agent: ['Intake helper', 'drafts replies from the enquiry; reads Leads only'], day: { doT: ['08:15', 'screens the enquiries that came in overnight and drafts a reply to each. It reads Leads only.'], yesT: ['08:45', 'approves the {gate} in Needs you, edits one line, and the Gate sends it.'] } },
  'Client onboarding': { stages: ['Welcome', 'Collect details', 'Documents signed', 'Set up', 'Kick-off done'], trigger: 'A record moves to Won', steps: ['Start a project from the Playbook', 'Fill the engagement letter', 'Send it for signature', 'Wait for the signature', 'Create the setup tasks'], gate: 'Engagement letter', agent: ['Onboarding helper', 'fills the letter and tracks the checklist; sees the new client only'], day: { doT: ['10:00', 'files the signed engagement letter on the client record and starts the setup tasks. The client signed on their phone, with no account.'], yesT: ['10:20', 'says yes to the {gate} and the onboarding Flow starts the checklist.'] } },
  'Recurring deliverables': { stages: ['Prepare', 'Review', 'Deliver', 'Follow up'], trigger: 'A schedule, in business hours', steps: ['For each active client, start a project', 'Agent drafts the deliverable', 'Ask the reviewer', 'Send'], gate: 'Deliverable to the client', agent: ['Drafting agent', 'prepares the first draft from the client record; cannot send'], day: { doT: ['11:30', 'finishes first drafts for each active client. It cannot send.'], yesT: ['14:00', 'reviews each draft, then says yes or sends it back with a note. The Gate holds the {gate}.'] } },
  'Document requests and chasing': { stages: ['Requested', 'Partly received', 'Complete'], trigger: 'A schedule, weekly', steps: ['Find clients with items missing', 'Agent drafts the request', 'Wait 3 days', 'Remind once, then assign a person'], gate: 'Request email', agent: ['Chaser', 'lists what is missing per client; drafts, never sends'], day: { doT: ['09:00', 'lists what each client still owes and drafts the request.'], yesT: ['09:30', 'approves the {gate}. The Flow waits three days, reminds once, then assigns a person.'] } },
  'Invoicing and payment chasing': { stages: ['To invoice', 'Sent', 'Paid', 'Overdue'], trigger: 'A job or stage reaches Done', steps: ['Fill the invoice from the record', 'Ask the approver', 'Send', 'Wait 3 days', 'If unpaid, assign a task'], gate: 'Invoice email', agent: ['Billing helper', 'prepares invoices from finished work; sees Invoices and the linked client'], day: { doT: ['13:00', 'prepares invoices from work that reached Done.'], yesT: ['15:00', 'checks the amounts and approves the {gate}. Unpaid invoices become tasks after three days.'] } },
  'Document signing': { stages: ['Drafted', 'Sent to sign', 'Signed', 'Filed'], trigger: 'A record reaches a stage', steps: ['Fill the Word template from the record', 'Send for signature', 'Wait for the signer', 'File the signed copy on the record'], gate: 'Document sent for signature', agent: ['Document agent', 'fills templates from records; a model never rewrites the document'], day: { doT: ['10:30', 'fills the template from the record. A model never rewrites the document.'], yesT: ['11:00', 'approves the {gate} and the document goes out for signature.'] } },
  'Reports and updates': { stages: ['Collect', 'Draft', 'Approve', 'Send'], trigger: 'A schedule, weekly', steps: ['Agent reads the week\'s records', 'Agent drafts the summary', 'Ask a person', 'Send'], gate: 'Report to the client', agent: ['Reporter', 'reads records and drafts the summary; cannot send'], day: { doT: ['16:00', 'reads the week\'s records and drafts the summary. It cannot send.'], yesT: ['16:30', 'reads it and approves the {gate}.'] } },
  'Deadlines and reminders': { stages: ['Upcoming', 'Due soon', 'Done'], trigger: 'A date on a record comes near', steps: ['Wait until 7 days before', 'Assign a task to the owner', 'Wait until 1 day before', 'Remind'], gate: 'Reminder to the client', agent: ['Deadline watcher', 'watches dates and raises tasks; reads Deadlines only'], day: { doT: ['07:30', 'checks which dates come near and assigns tasks to their owners.'], yesT: ['08:20', 'approves the {gate} for anything that reaches a client.'] } },
};

const INDUSTRIES = {
  accounting: { name: 'Accounting and tax', roles: ['Partner', 'Manager', 'Senior accountant', 'Bookkeeper', 'Admin'], things: ['Clients', 'Engagements', 'Filings and deadlines', 'Invoices'], work: ['Client onboarding', 'Recurring deliverables', 'Document requests and chasing', 'Invoicing and payment chasing'], tools: ['QuickBooks', 'Xero', 'Google Workspace', 'Microsoft 365', 'Stripe'], nevers: ['Client email', 'Filings and submissions', 'Payments and refunds'] },
  law: { name: 'Law', roles: ['Partner', 'Associate', 'Paralegal', 'Intake coordinator', 'Office manager'], things: ['Clients', 'Matters', 'Leads', 'Invoices'], work: ['New enquiry follow-up', 'Client onboarding', 'Document signing', 'Invoicing and payment chasing'], tools: ['Clio', 'Lawmatics', 'GoHighLevel', 'Google Workspace', 'Microsoft 365'], nevers: ['Client email', 'Anything signed', 'Filings and submissions'] },
  agency: { name: 'Marketing agency', roles: ['Owner', 'Account manager', 'Strategist', 'Designer', 'Operations lead'], things: ['Clients', 'Projects', 'Campaigns', 'Leads', 'Invoices'], work: ['New enquiry follow-up', 'Client onboarding', 'Reports and updates', 'Invoicing and payment chasing'], tools: ['HubSpot', 'Slack', 'Google Workspace', 'Stripe'], nevers: ['Client email', 'Publishing a page', 'Payments and refunds'] },
  consulting: { name: 'Consulting', roles: ['Principal', 'Consultant', 'Analyst', 'Operations lead'], things: ['Clients', 'Projects', 'Deals', 'Invoices'], work: ['New enquiry follow-up', 'Client onboarding', 'Reports and updates', 'Invoicing and payment chasing'], tools: ['Salesforce', 'Slack', 'Google Workspace', 'Microsoft 365'], nevers: ['Client email', 'Anything signed', 'Payments and refunds'] },
  realestate: { name: 'Real estate', roles: ['Broker', 'Agent', 'Transaction coordinator', 'Admin'], things: ['Clients', 'Properties', 'Deals', 'Appointments'], work: ['New enquiry follow-up', 'Document signing', 'Deadlines and reminders'], tools: ['Zoho', 'RingCentral', 'Google Workspace', 'Stripe'], nevers: ['Client email', 'Anything signed', 'Publishing a page'] },
  advice: { name: 'Financial advice', roles: ['Principal advisor', 'Associate advisor', 'Paraplanner', 'Client service'], things: ['Clients', 'Accounts', 'Appointments', 'Invoices'], work: ['Client onboarding', 'Recurring deliverables', 'Document signing', 'Deadlines and reminders'], tools: ['Microsoft 365', 'Salesforce', 'Google Workspace', 'RingCentral'], nevers: ['Client email', 'Anything signed', 'Payments and refunds'] },
  other: { name: 'Another kind of business', roles: ['Owner', 'Manager', 'Team member'], things: ['Clients', 'Projects', 'Invoices'], work: ['New enquiry follow-up', 'Client onboarding', 'Invoicing and payment chasing'], tools: ['Google Workspace', 'Slack'], nevers: ['Client email', 'Payments and refunds'] },
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

const MAP_DATA = { industries: INDUSTRIES, more: MORE, things: THINGS, work: WORK, planned: PLANNED_INTEGRATIONS, sizes: ['1 to 5 people', '6 to 15 people', '16 to 50 people', 'More than 50 people'] };

const chipGroup = (cat, label, hint, ph) => `<div class="cg"><p class="cg-l" id="cg-${cat}">${label}</p>${hint ? `<p class="cg-h">${hint}</p>` : ''}<div class="chips" data-cat="${cat}" role="group" aria-labelledby="cg-${cat}"></div><div class="addrow"><input type="text" data-add="${cat}" placeholder="${ph}" aria-label="Add to: ${label}" maxlength="60"><button type="button" data-addbtn="${cat}">Add</button></div></div>`;

const MAP_STYLE = `<style>
.mapper{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:clamp(20px,3vw,40px);align-items:start}
@media(max-width:960px){.mapper{grid-template-columns:1fr}}
.stepper{border:1px solid var(--line);background:var(--panel);padding:20px;min-width:0}
.prog{margin:0 0 14px}
#prog{list-style:none;margin:0 0 8px;padding:0;display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
#prog button{width:100%;font:500 10.5px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);background:transparent;border:0;border-top:2px solid var(--line-2);padding:8px 0 0;text-align:left;cursor:pointer;transition:color .2s,border-color .2s}
#prog button.done{border-top-color:var(--accent);color:var(--ink-2)}
#prog button[aria-current=step]{color:var(--ink);border-top-color:var(--accent)}
#prog button:focus-visible,.stepper button:focus-visible,.stepper input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:520px){#prog button{font-size:0;padding-top:10px}}
.prog-bar{height:3px;background:var(--line);overflow:hidden}
.prog-bar i{display:block;height:100%;width:20%;background:var(--accent);transition:width .45s var(--ease)}
.sp-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 18px}
#step-count{font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.skip{font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);background:none;border:0;padding:4px 0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.stepper [data-step]{animation:stin .35s var(--ease) both}
@keyframes stin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.stepper h2{font:600 clamp(22px,2.4vw,28px)/1.15 var(--sans);letter-spacing:-.02em;margin:0 0 6px;outline:0}
.stepper .q-h{font-size:14.5px;color:var(--ink-2);margin:0 0 18px}
.cg{margin:0 0 20px}
.cg-l{font:500 11px/1.4 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin:0 0 8px}
.cg-h{font-size:13.5px;color:var(--ink-3);margin:-4px 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px}
.chips button{font:400 14px var(--sans);color:var(--ink-2);background:transparent;border:1px solid var(--line-2);border-radius:999px;padding:7px 13px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.chips button:hover{border-color:var(--ink-3)}
.chips button[aria-pressed=true]{color:var(--ink);background:var(--accent-wash);border-color:var(--accent)}
.chips.big button{border-radius:6px;padding:11px 15px;font-size:15px}
.addrow{display:flex;gap:6px}
.addrow input{flex:1;min-width:0;font:400 15px var(--sans);color:var(--ink);background:var(--bg);border:1px solid var(--line-2);border-radius:4px;padding:9px 10px}
.addrow button{font:500 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink);background:transparent;border:1px solid var(--line-2);border-radius:4px;padding:0 14px;cursor:pointer}
.addrow button:hover{border-color:var(--ink)}
.need{font-size:13.5px;color:var(--accent);margin:-8px 0 14px}
.nav{display:flex;justify-content:space-between;gap:10px;margin-top:8px;padding-top:16px;border-top:1px solid var(--line)}
.nav button{height:44px;padding:0 22px;font:500 12px/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;cursor:pointer;border:1px solid var(--ink);background:transparent;color:var(--ink)}
.nav button.pri{background:var(--ink);color:var(--bg)}
.nav button:disabled{opacity:.35;cursor:not-allowed}
.live{border:1px solid var(--line);background:var(--panel);padding:16px 16px 12px;min-width:0}
.live-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 10px}
.live-h .lbl{margin:0}
#dg-sum{font:400 12px var(--mono);color:var(--ink-3)}
.dg{width:100%;height:auto;display:block;overflow:visible}
.dg .nd{transition:transform .6s var(--ease),opacity .35s}
.dg .nd.dim,.dg .ed.dim{opacity:.32}
.dg .inn{transition:opacity .4s,scale .45s var(--ease);transform-box:fill-box;transform-origin:center}
.dg .nd.enter .inn{opacity:0;scale:.82}
.dg .ed{fill:none;stroke:var(--line-2);stroke-width:1.2;transition:opacity .4s,d .6s var(--ease)}
.dg .ed.enter{opacity:0}
.dg .ed-tool{stroke:var(--accent);stroke-dasharray:3 4;opacity:.85}
.dg .ed-tool.dim{opacity:.25}
.dg .ed-pa{stroke:var(--accent);opacity:.7}
.dg .ed-rec{stroke:var(--ink-3)}
.dg .ed-soft{stroke:var(--line-2);stroke-dasharray:2 4}
.dg .ed-rail{stroke:var(--line-2)}
.dg .ed-chain{stroke:var(--ink-3)}
.dg .arr{fill:var(--ink-3)}
.dg .nb{fill:var(--bg);stroke:var(--line-2);stroke-width:1}
.dg .nb-person{fill:var(--bg)}
.dg .nb-agent{fill:var(--accent-wash);stroke:var(--accent)}
.dg .nb-rec{fill:var(--sunk);stroke:var(--line-2)}
.dg .nb-hub{stroke:var(--ink-3);stroke-width:1.4}
.dg .nb-tool{stroke-dasharray:3 3;stroke:var(--accent)}
.dg .nb-more{stroke-dasharray:2 3;fill:none}
.dg .nb-step{fill:var(--bg)}
.dg .nb-trig{fill:var(--accent-wash);stroke:var(--line-2)}
.dg .nb-gate{fill:var(--accent);stroke:var(--accent)}
.dg .tx{font:500 11px var(--sans);fill:var(--ink)}
.dg .tx2{font:400 10.5px var(--sans);fill:var(--ink-2)}
.dg .gt{font:500 10.5px var(--sans);fill:var(--bg)}
.dg .hb{font-weight:600}
.dg .wn{font-size:12px;font-weight:600}
.dg .wsub{font:400 9.5px var(--mono);fill:var(--ink-3);letter-spacing:.04em}
.dg .lb{font:500 9.5px var(--mono);letter-spacing:.1em;fill:var(--ink-3)}
.dg .gh{font:400 11px var(--sans);fill:var(--ink-3)}
.dg .dot{fill:var(--bg);stroke:var(--accent);stroke-width:1.4}
.dg .ownd{fill:var(--accent)}
.dg .agd{fill:var(--accent)}
.dg .tld{fill:none;stroke:var(--accent);stroke-width:1.4}
.dg .lock{fill:var(--bg)}
.dg .lock-s{fill:none;stroke:var(--bg);stroke-width:1.4}
@media(prefers-reduced-motion:reduce){.dg .nd,.dg .inn,.dg .ed,.prog-bar i{transition:none}.stepper [data-step]{animation:none}}
.res-top{max-width:62em}
.counts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;border:1px solid var(--line);margin:26px 0 0}
@media(max-width:900px){.counts{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cnt{padding:18px 18px 16px;border-left:1px solid var(--line);margin-left:-1px;border-top:1px solid var(--line);margin-top:-1px;display:flex;flex-direction:column;gap:2px;background:var(--panel)}
.cnt b{font:600 clamp(34px,4vw,48px)/1 var(--sans);letter-spacing:-.03em;color:var(--ink)}
.cnt .cn{font:500 11px var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--accent);margin-top:6px}
.cnt .cs{font-size:12.5px;color:var(--ink-3)}
.res-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:clamp(24px,4vw,56px);margin-top:44px}
@media(max-width:900px){.res-grid{grid-template-columns:1fr}}
.res-grid .lbl,.sec .res-h3{margin:0 0 14px}
.res-grid .day{margin-top:8px}
.day li b{margin-right:5px}
.empty{color:var(--ink-3);font-size:14.5px;list-style:none}
.tlc{border:1px solid var(--line);padding:12px 14px;margin:0 0 -1px;background:var(--panel)}
.tlc b{display:block;color:var(--ink);font-size:15.5px;margin-bottom:3px}
.tlc p{margin:0;font-size:13.5px;color:var(--ink-2)}
.tlc .soon{display:block;margin-top:5px;font:500 13px var(--sans);color:var(--accent)}
.fnote{font-size:12.5px;color:var(--ink-3);margin:10px 0 0}
.gates-h{margin-top:30px!important}
.play-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:6px}
.play-grid{}@media(max-width:700px){.play-grid{grid-template-columns:1fr}}
.pc{border:1px solid var(--line);background:var(--panel);padding:14px 16px}
.pc b{display:block;font-size:15.5px;margin-bottom:4px}
.pc p{margin:0 0 4px;font-size:13.5px;color:var(--ink-2)}
.pc .k{font:500 10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.acts{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:clamp(24px,4vw,56px);align-items:start;margin-top:48px}
@media(max-width:900px){.acts{grid-template-columns:1fr}}
.acts .btn-row{margin-top:18px}
.acts details{margin-top:14px;border:1px solid var(--line);background:var(--panel)}
.acts summary{cursor:pointer;padding:11px 14px;font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2)}
.acts details pre{margin:0;padding:0 14px 14px;font:400 12.5px/1.55 var(--mono);color:var(--ink-2);white-space:pre-wrap;overflow-wrap:anywhere}
.acts button.btn{font-family:var(--mono)}
</style>`;

export const MAP_META = {
  slug: 'map', path: '/map/',
  title: 'Map your business onto Vyre',
  desc: 'Pick your industry, team, records and tools, and get a prompt that makes your own AI agent map your business onto Vyre: members, records, Playbooks, Flows and approvals.',
  ogTitle: 'Map your business.', ogSub: 'A prompt for your own AI agent, tailored to your business.',
};

export function mapBody({ MAP_URL, REPO, eyebrow, JS }) {
  const step = (n, h, q, inner) => `<div data-step="${n}"${n > 0 ? ' hidden' : ''}><h2 tabindex="-1">${h}</h2><p class="q-h">${q}</p>${inner}</div>`;
  return `${STYLE}${MAP_STYLE}
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Map your business</p>
    ${eyebrow('Give it to your AI agent.')}
    <h1 class="display">Map your business <b>onto Vyre.</b></h1>
    <p class="lead">Answer five short questions and watch your business take shape on Vyre: people as members with roles, agents beside them, the things you track as linked records, the work you repeat as Playbooks and Flows, and a Gate where anything leaves the team. Then copy a prompt that makes your own AI agent build it. Nothing you pick leaves this page.</p>
  </div>
</section>

<section class="sec" style="padding-top:40px" aria-labelledby="mapper-h">
  <div class="wrap">
    <h2 id="mapper-h" class="lbl" style="margin-bottom:20px">Your business, step by step</h2>
    <div class="mapper" id="mapper">
      <form class="stepper needs-js" id="mform" onsubmit="return false" aria-label="About your business">
        <div class="prog">
          <ol id="prog">${['Business', 'Team', 'Track', 'Repeat', 'Tools'].map((n, i) => `<li><button type="button" aria-label="Step ${i + 1}: ${n}"${i === 0 ? ' aria-current="step"' : ''}>${n}</button></li>`).join('')}</ol>
          <div class="prog-bar" aria-hidden="true"><i id="prog-fill"></i></div>
        </div>
        <div class="sp-meta"><span id="step-count" aria-live="polite">Step 1 of 5</span><button type="button" class="skip" id="skip">Skip to the result</button></div>
        ${step(0, 'What kind of business is it?', 'Pick the closest one. It pre-selects sensible choices for the next steps, and you can change every one.', `<div class="cg"><p class="cg-l">Industry</p><div class="chips big" id="ind-grid" role="group" aria-label="Industry"></div></div><div class="cg"><p class="cg-l">Team size</p><div class="chips" id="size-grid" role="group" aria-label="Team size"></div></div><p class="need" id="ind-need">Pick an industry to go on.</p>`)}
        ${step(1, 'Who is on your team?', 'Each role becomes a member with a role. You are the Owner. Agents join them, each with one job.', chipGroup('roles', 'Roles', '', 'Another role'))}
        ${step(2, 'What do you keep track of?', 'Each one becomes a record type. Record types link to each other in a web you shape.', chipGroup('things', 'Things you track', '', 'Something else you track'))}
        ${step(3, 'What work do you repeat?', 'Each kind of work becomes a Playbook with stages, a Flow that moves it along, and an agent with one job.', chipGroup('work', 'Work you repeat', '', 'Other repeated work'))}
        ${step(4, 'Your tools, and what needs a yes', 'Name the tools Vyre should work with. Then pick what must never go out until a person approves it.', chipGroup('tools', 'Tools you use', '', 'Another tool') + chipGroup('nevers', 'Never goes out without a yes', '', 'Something else'))}
        <div class="nav"><button type="button" id="back">Back</button><button type="button" class="pri" id="next">Next</button></div>
      </form>
      <div class="live" id="live">
        <div class="live-h"><span class="lbl">Your business on Vyre, live</span><span id="dg-sum" aria-live="polite"></span></div>
        <div id="dg-wrap"></div>
        <p class="sk-sum no-js" style="color:var(--ink-2)">Turn on JavaScript to build the diagram. The full prompt below works as it is.</p>
      </div>
    </div>
    <script type="application/json" id="map-data">${JSON.stringify(MAP_DATA).replace(/</g, '\\u003c')}</script>
  </div>
</section>

<section class="sec" id="result" aria-labelledby="res-h" tabindex="-1" style="padding-top:20px">
  <div class="wrap">
    <p class="lbl" style="margin-bottom:12px">Your result</p>
    <h2 id="res-h" class="h2 res-top" tabindex="-1">Your business, <b>AI-native.</b></h2>
    <p class="lead" style="max-width:46em;margin-top:12px">People decide. Agents do the work, one job each. Vyre holds the records, the Playbooks and the Flows, and stops at the Gate wherever something leaves the team.</p>
    <div class="counts" id="res-counts" role="list"></div>
    <div class="res-grid">
      <div><h3 class="lbl">A day in the life</h3><ul class="day" id="res-day"></ul></div>
      <div>
        <h3 class="lbl">What Vyre does for each tool</h3><div id="res-tools"></div>
        <h3 class="lbl gates-h">Held at the Gate until a person says yes</h3><ul class="flow" id="res-gates"></ul>
      </div>
    </div>
    <h3 class="lbl" style="margin:48px 0 12px">Playbooks and Flows</h3>
    <div class="play-grid" id="res-play"></div>

    <div class="acts" id="actions">
      <div>
        <span class="num">Take it with you</span>
        <h2 id="prompt-h" class="h2" style="margin-top:8px">Copy it. Paste it into <b>your AI.</b></h2>
        <ol class="ap-steps">
          <li><span><b>Paste</b> the prompt into ChatGPT, Claude or any agent that can read links.</span></li>
          <li><span><b>Answer</b> its questions. Everything you picked here, it already knows.</span></li>
          <li><span><b>Say yes</b> if you want it built. The agent can set Vyre up for you over Vyre&rsquo;s MCP.</span></li>
        </ol>
        <p class="btn-row">
          <button class="btn btn-fill" type="button" id="act-build">Ask your AI agent to build it</button>
          <button class="btn" type="button" id="act-share">Copy a share link</button>
          <a class="btn" href="/start/">Set up Vyre</a>
        </p>
        <p class="fnote">The share link holds your choices in the address after the #. Nothing goes to a server.</p>
      </div>
      <div>
        <div class="pbox">
          <div class="pbox-bar"><span class="lbl" id="out-lbl">Prompt &middot; one line, plain text</span><button class="cp" type="button" data-copy-from="prompt-out" aria-label="Copy the prompt">Copy</button></div>
          <pre id="prompt-out" tabindex="0">${esc(PROMPT)}</pre>
        </div>
        <details><summary>The build prompt, with one more line</summary><pre id="build-out">${esc(PROMPT)}</pre></details>
        <p class="btn-row" style="margin-top:14px"><a class="btn btn-sm" href="/agenthome/">What your agent reads</a> <a class="btn btn-sm" href="${MAP_URL}">The method</a></p>
      </div>
    </div>
  </div>
</section>
<script src="${JS}" defer></script>

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
      <a href="/records/"><b>Records</b>Objects you shape, linked in any web.</a>
      <a href="/vault/"><b>Vault</b>Credentials agents use without seeing.</a>
      <a href="/flows/"><b>Flows</b>Triggers, steps and approvals.</a>
      <a href="/agents/"><b>Agents</b>Instructions, memory and access.</a>
      <a href="/computer/"><b>Computer</b>Work in sites that have no API.</a>
      <a href="/for/"><b>For industries</b>Vyre mapped to your kind of business.</a>
      <a href="/compare/"><b>Compare</b>How the approaches differ.</a>
      <a href="${SITE}/docs/architecture/features/mcp-and-engineer"><b>MCP and the Engineer</b>How an agent connects and builds.</a>
    </div>
  </div>
</section>

<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">See your business <b>on Vyre.</b></h2><div class="btn-row"><a class="btn btn-fill" href="#actions">Copy the prompt</a><a class="btn" href="/start/">Set up Vyre</a></div></div></section>`;
}
