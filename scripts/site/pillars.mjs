// pillars.mjs: the four deep product pages on vyre.run (/vault/, /records/, /flows/, /agents/).
// scripts/gen-site.mjs imports pillarPages() and writes each page with its own page(). Wording follows docs/architecture/features/{vault,records,flows,agents}.md
// on main, and every code path named here is one those pages cite. The styles for the pl-* classes are in site/v2.css.

const SVG_OPEN = (label, vb = '0 0 760 230') => `<svg class="pl-svg" viewBox="${vb}" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">`;

// A box in an animation: x, y, w, h, title, one small line.
const box = (x, y, w, h, t, s, cls = '') => `<g class="pl-bx ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/><text class="pl-t" x="${x + w / 2}" y="${y + h / 2 - 3}" text-anchor="middle">${t}</text><text class="pl-s" x="${x + w / 2}" y="${y + h / 2 + 15}" text-anchor="middle">${s}</text></g>`;

// ---------- the four animations ----------
const ANIM_VAULT = `${SVG_OPEN('A sealed value in motion. An agent asks to use the Twilio item. The door checks the grant, the Gate holds the send for a person, and the Vault puts the key into the call at send time. The model only ever sees the name of the item.')}
  <line class="pl-ln" x1="140" y1="135" x2="170" y2="135"/><line class="pl-ln" x1="300" y1="135" x2="330" y2="135"/><line class="pl-ln" x1="460" y1="135" x2="490" y2="135"/><line class="pl-ln" x1="620" y1="135" x2="650" y2="135"/>
  ${box(10, 100, 130, 70, 'Agent kit', 'asks to use Twilio')}
  ${box(170, 100, 130, 70, 'The door', 'holds a grant?')}
  ${box(330, 100, 130, 70, 'The Gate', 'a person says yes', 'pl-hold')}
  ${box(490, 100, 130, 70, 'The Vault', 'releases at send time')}
  ${box(650, 100, 100, 70, 'Twilio', 'gets the key')}
  <line class="pl-ln pl-dash" x1="75" y1="61" x2="715" y2="61"/>
  <g class="pl-pk pl-pk-a"><rect x="30" y="50" width="90" height="22" rx="11" class="pl-pkr"/><text x="75" y="65" class="pl-pkt" text-anchor="middle">use: Twilio</text></g>
  <g class="pl-pk pl-pk-b"><rect x="30" y="50" width="90" height="22" rx="11" class="pl-pkr pl-key"/><text x="75" y="65" class="pl-pkt pl-keyt" text-anchor="middle">&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;</text></g>
  <path class="pl-br" d="M10 198v8h450v-8"/><text class="pl-s" x="235" y="224" text-anchor="middle">The model sees the item&rsquo;s name. Never the value.</text>
  <path class="pl-br" d="M490 198v8h260v-8"/><text class="pl-s" x="620" y="224" text-anchor="middle">The value exists only here, inside the call.</text>
  <text class="pl-m pl-hold-lbl" x="395" y="92" text-anchor="middle">held for a yes</text>
</svg>`;

const ANIM_RECORDS = `${SVG_OPEN('Three linked records, Task, Project and Client. A highlight hops along the links for the token task.project.client.phone and lands on the client&rsquo;s phone number. Sample data.')}
  <g class="pl-bx"><rect x="10" y="40" width="210" height="104" rx="6"/><text class="pl-m" x="24" y="62">TASK</text><text class="pl-t" x="24" y="86">Send the quote</text><text class="pl-s" x="24" y="108">project</text><text class="pl-s" x="24" y="126">links to a Project</text></g>
  <g class="pl-bx"><rect x="275" y="40" width="210" height="104" rx="6"/><text class="pl-m" x="289" y="62">PROJECT</text><text class="pl-t" x="289" y="86">Kitchen remodel, Reyes</text><text class="pl-s" x="289" y="108">client</text><text class="pl-s" x="289" y="126">links to a Client</text></g>
  <g class="pl-bx"><rect x="540" y="40" width="210" height="104" rx="6"/><text class="pl-m" x="554" y="62">CLIENT</text><text class="pl-t" x="554" y="86">Sam Reyes</text><text class="pl-s" x="554" y="108">phone</text><text class="pl-t pl-ph" x="554" y="126">+1 415 555 0190</text></g>
  <rect class="pl-lit pl-lit-a" x="10" y="40" width="210" height="104" rx="6"/><rect class="pl-lit pl-lit-b" x="275" y="40" width="210" height="104" rx="6"/><rect class="pl-lit pl-lit-c" x="540" y="40" width="210" height="104" rx="6"/>
  <path class="pl-ln" d="M220 92h55"/><path class="pl-ln" d="M485 92h55"/>
  <text class="pl-s" x="247" y="84" text-anchor="middle">project</text><text class="pl-s" x="512" y="84" text-anchor="middle">client</text>
  <text class="pl-s" x="247" y="112" text-anchor="middle">tasks</text><text class="pl-s" x="512" y="112" text-anchor="middle">projects</text>
  <circle class="pl-hop" cx="220" cy="92" r="6"/>
  <text class="pl-tok" x="380" y="190" text-anchor="middle"><tspan class="pl-k0">{task</tspan><tspan class="pl-k1">.project</tspan><tspan class="pl-k2">.client</tspan><tspan class="pl-k3">.phone}</tspan></text>
  <text class="pl-s pl-res" x="380" y="214" text-anchor="middle">prints +1 415 555 0190</text>
</svg>`;

const ANIM_FLOWS = `${SVG_OPEN('A Flow running. A form is submitted, the Flow finds or creates the contact, hands the draft to an agent, then holds for a person to approve, and only then sends. Sample data.', '0 0 760 240')}
  <line class="pl-ln" x1="140" y1="135" x2="160" y2="135"/><line class="pl-ln" x1="290" y1="135" x2="310" y2="135"/><line class="pl-ln" x1="440" y1="135" x2="460" y2="135"/><line class="pl-ln" x1="590" y1="135" x2="610" y2="135"/>
  ${box(10, 100, 130, 70, 'A form is', 'submitted', 'pl-n1')}
  ${box(160, 100, 130, 70, 'Find or create', 'the contact', 'pl-n2')}
  ${box(310, 100, 130, 70, 'Hand to kit', 'an agent drafts', 'pl-n3')}
  ${box(460, 100, 130, 70, 'Ask Alex', 'to approve', 'pl-n4 pl-hold')}
  ${box(610, 100, 130, 70, 'Send the email', 'exact approved words', 'pl-n5')}
  <text class="pl-m" x="75" y="92" text-anchor="middle">TRIGGER</text>
  <line class="pl-ln pl-dash" x1="75" y1="61" x2="675" y2="61"/>
  <g class="pl-pk pl-pk-f"><circle cx="75" cy="61" r="9" class="pl-dot"/></g>
  <g class="pl-badge"><rect x="448" y="186" width="154" height="26" rx="13"/><text x="525" y="203" text-anchor="middle">Needs you: held</text></g>
  <g class="pl-ok"><rect x="478" y="186" width="94" height="26" rx="13"/><text x="525" y="203" text-anchor="middle">Approved</text></g>
  <text class="pl-s" x="380" y="232" text-anchor="middle">Each step is written to the run&rsquo;s ledger before and after it acts.</text>
</svg>`;

const ANIM_AGENTS = `${SVG_OPEN('A task wakes an agent. The task is ready and its doer is the agent kit. The agent wakes, works the task, and either finishes it or marks it stuck with a plain reason. Sample data.')}
  <g class="pl-bx"><rect x="10" y="62" width="210" height="104" rx="6"/><text class="pl-m" x="24" y="84">TASK &middot; READY</text><text class="pl-t" x="24" y="108">Draft the intake summary</text><text class="pl-s" x="24" y="130">doer: kit, an agent</text><text class="pl-s" x="24" y="148">from the Intake Flow</text></g>
  <path class="pl-ln pl-dash" d="M220 114h86"/><text class="pl-m" x="263" y="104" text-anchor="middle">wakes</text>
  <g class="pl-ag"><circle cx="350" cy="114" r="42" class="pl-agc"/><circle cx="350" cy="114" r="42" class="pl-agp"/><text class="pl-t" x="350" y="112" text-anchor="middle">kit</text><text class="pl-s" x="350" y="130" text-anchor="middle">job thread</text></g>
  <path class="pl-ln" d="M392 114h58"/>
  <g class="pl-o1"><rect x="450" y="62" width="300" height="104" rx="6" class="pl-oka"/><text class="pl-m" x="466" y="84">DONE</text><text class="pl-t" x="466" y="108">Handed in for a check</text><text class="pl-s" x="466" y="130">The task moves on. Nothing</text><text class="pl-s" x="466" y="148">is left open in silence.</text></g>
  <g class="pl-o2"><rect x="450" y="62" width="300" height="104" rx="6" class="pl-stk"/><text class="pl-m" x="466" y="84">STUCK</text><text class="pl-t" x="466" y="108">The AI sign-in expired</text><text class="pl-s" x="466" y="130">Suggested fix: reconnect the AI</text><text class="pl-s" x="466" y="148">account. It shows in Needs you.</text></g>
  <text class="pl-s" x="380" y="204" text-anchor="middle">A task ends one of three ways: finished, handed on, or stuck with a reason.</text>
</svg>`;

// ---------- diagrams ----------
const GRAPH_RECORDS = `${SVG_OPEN('Four record types joined by links, each with a named inverse. A task links to a project, a project to a client, a client to an organization. A computed field on the client totals the fees of its projects.', '0 0 760 250')}
  <g class="pl-bx"><rect x="10" y="30" width="150" height="62" rx="6"/><text class="pl-t" x="85" y="58" text-anchor="middle">Task</text><text class="pl-s" x="85" y="76" text-anchor="middle">stage, due, doer</text></g>
  <g class="pl-bx"><rect x="215" y="30" width="150" height="62" rx="6"/><text class="pl-t" x="290" y="58" text-anchor="middle">Project</text><text class="pl-s" x="290" y="76" text-anchor="middle">stage set, fee</text></g>
  <g class="pl-bx"><rect x="420" y="30" width="150" height="62" rx="6"/><text class="pl-t" x="495" y="58" text-anchor="middle">Client</text><text class="pl-s" x="495" y="76" text-anchor="middle">a Contact with a role</text></g>
  <g class="pl-bx"><rect x="630" y="30" width="120" height="62" rx="6"/><text class="pl-t" x="690" y="58" text-anchor="middle">Organization</text><text class="pl-s" x="690" y="76" text-anchor="middle">one firm</text></g>
  <path class="pl-ln" d="M160 52h55"/><path class="pl-ln" d="M365 52h55"/><path class="pl-ln" d="M570 52h60"/>
  <text class="pl-m" x="188" y="44" text-anchor="middle">project</text><text class="pl-m" x="393" y="44" text-anchor="middle">client</text><text class="pl-m" x="600" y="44" text-anchor="middle">org</text>
  <text class="pl-s" x="188" y="72" text-anchor="middle">tasks</text><text class="pl-s" x="393" y="72" text-anchor="middle">projects</text><text class="pl-s" x="600" y="72" text-anchor="middle">people</text>
  <path class="pl-ln" d="M495 92V132"/>
  <g class="pl-bx pl-comp"><rect x="370" y="132" width="250" height="44" rx="6"/><text class="pl-t" x="495" y="159" text-anchor="middle">Client.fees = total of its projects</text></g>
  <text class="pl-s" x="380" y="212" text-anchor="middle">A link names its inverse. Set one side and the other side appears on the target type.</text>
  <text class="pl-s" x="380" y="232" text-anchor="middle">A token walks the links: {task.project.client.phone}</text>
</svg>`;

// ---------- small page builders ----------
const chip = (t) => `<span class="pl-chip">${t}</span>`;
const card = (n, t, p) => `<div class="piece"><span class="num">${n}</span><h3>${t}</h3><p>${p}</p></div>`;
const grid = (cards) => `<div class="pieces pl-grid rv">${cards.map(([t, p], i) => card(String(i + 1).padStart(2, '0'), t, p)).join('')}</div>`;
const steps = (items, n) => `<ol class="ar-flow rv" style="--n:${n || items.length}">${items.map(([t, d], i) => `<li class="ar-node"><span class="ar-n">${i + 1}</span><b>${t}</b><span>${d}</span></li>`).join('')}</ol>`;
const facts = (items) => `<ul class="ar-facts rv">${items.map(([b, s]) => `<li><b>${b}</b>${s}</li>`).join('')}</ul>`;
const cols3 = (items) => `<div class="ar-outcomes rv">${items.map(([t, p]) => `<div class="ar-out-card pl-oc"><p class="lbl">${t}</p><p>${p}</p></div>`).join('')}</div>`;
const head = (eyebrowText, h, lead, id) => `<div class="sec-head rv"><p class="eyebrow">${eyebrowText}</p><h2 id="${id}" class="h2">${h}</h2>${lead ? `<p class="lead">${lead}</p>` : ''}</div>`;
const shot = (file, alt, cap) => `<figure class="pl-shot rv"><div class="frame"><span class="pl-a pl-a1">+</span><span class="pl-b pl-b1">+</span><img src="/media/${file}" width="2000" height="1250" alt="${alt}"></div><figcaption>${cap}</figcaption></figure>`;

export function pillarPages({ esc, eyebrow, crumbs, SITE, REPO, MAP_URL, VERSION }) {
  const doc = (p) => `${REPO}/blob/main/${p}`;
  const connects = (items) => `<section class="sec" aria-labelledby="cn-h"><div class="wrap">${head('Connects to.', 'How it fits <b>with the rest of Vyre.</b>', '', 'cn-h')}<div class="pl-conn rv">${items.map(([href, t, p]) => `<a href="${href}"><b>${t}</b><span>${p}</span><i class="go">Open &rarr;</i></a>`).join('')}</div></div></section>`;
  const nextBlock = (items) => `<section class="sec" aria-labelledby="nx-h"><div class="wrap"><div class="note pl-next rv"><p class="lbl" id="nx-h" style="margin-bottom:8px"><span class="chip-next">Coming next</span></p><ul class="plain" style="margin:0 0 10px;padding-left:1.1em">${items.map((x) => `<li style="margin:.35em 0">${x}</li>`).join('')}</ul><p class="sm" style="margin:0">Direction, not a shipped feature. Dates and scope live on the <a href="/direction/">direction page</a>.</p></div></div></section>`;
  const extend = (what) => `<section class="sec" aria-labelledby="ex-h"><div class="wrap feat"><div class="feat-copy rv"><span class="num">Extend it</span><h2 id="ex-h" class="h2">Bring your own software stack, <b>or build a module.</b></h2><p class="lead">Vyre can be extended by integrating your Zoho, QuickBooks, RingCentral and the rest of your software stack*. ${what}</p><p class="sm">*where the vendor provides an API</p></div><div class="mock rv"><div class="win" role="group" aria-label="Two ways in"><div class="win-bar"><i></i><i></i><i></i><span class="t">Two ways in</span></div><dl class="kv"><dt><span class="chip-next">Coming in 0.7</span></dt><dd>Integrations, packaged as modules, for the software a firm already runs.</dd><dt>Today</dt><dd>A connection in the Vault plus a Flow web step, or a custom module. It passes through the same grants and checks as any other.</dd><dt>Over MCP</dt><dd>An AI agent connected over Vyre&rsquo;s MCP can help set this up. It acts as the person who connected it, within its key&rsquo;s reach, and the Gate still holds anything that leaves.</dd></dl><div class="sysline">Modules and Integrations: <a href="${doc('ARCHITECTURE.md')}#how-to-extend-vyre">how to extend Vyre</a></div></div></div></div></section>`;
  const closing = `<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">See it <b>working.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="${MAP_URL}">Point your AI agent at the repo</a></div></div></section>`;
  const pageHead = (slug, name, h1, lead, chips) => `<section class="phead"><div class="wrap"><p class="crumbs"><a href="/">Vyre</a> / <a href="/architecture/">Architecture</a> / ${name}</p>${eyebrow(`${name}, one of the four pillars.`)}<h1 class="display">${h1}</h1><p class="lead">${lead}</p><div class="pl-chips">${chips.map(chip).join('')}</div></div></section>`;
  const animSec = (id, num, h, lead, listItems, svg, label) => `<section class="sec" aria-labelledby="${id}"><div class="wrap feat pl-stack flip"><div class="feat-copy rv"><span class="num">${num}</span><h2 id="${id}" class="h2">${h}</h2><p class="lead">${lead}</p><ul class="list">${listItems.map(([b, s]) => `<li><b>${b}</b><span>${s}</span></li>`).join('')}</ul></div><div class="rv"><div class="pl-anim"><p class="lbl">${label}</p>${svg}</div></div></div></section>`;
  const code = (s) => `<code>${s}</code>`;
  const repoLinks = (items) => `<p class="sm rv" style="margin-top:26px">Code paths: ${items.map(([p, t]) => `<a href="${doc(p)}">${t}</a>`).join(' &middot; ')}</p>`;

  // ======================= VAULT =======================
  const VAULT = `${pageHead('vault', 'Vault', 'The Vault: <b>secrets an agent can use and never read.</b>',
    'Vyre keeps passwords, keys, sign-ins and cards sealed on disk. It hands one item at a time to the person, module or agent that holds a grant for it, and a model never sees a value.',
    ['AES-256-GCM, a key per item version', 'Use-only grants for agents', 'Every reveal and use is logged', 'A person&rsquo;s yes to reveal'])}

${animSec('v1-h', 'A sealed value, in motion', 'An agent uses a credential. <b>The model sees a name.</b>',
    'An agent asks for a use and never for a value. It names the item, and the system attaches the key at the moment of sending, after the door has checked the grant and, for anything that leaves, after a person has said yes.',
    [['The grant is a kernel fact', 'Lending a login to an agent is a kernel grant on one item: the agent&rsquo;s stable id, one action, one exact site, until an expiry. The Vault keeps no table of who may use what.'], ['Items you cannot use do not exist', 'A model is told about an item only if it holds a grant on it. Any other name answers as if it were not there.'], ['A missing sign-in is a stuck task', 'The agent marks the task stuck with a fix that names the item, and the person&rsquo;s card opens the Add sheet.']],
    ANIM_VAULT, 'Animation: what a send with a vault credential does')}

<section class="sec" aria-labelledby="v2-h"><div class="wrap">
  ${head('What it stores.', 'Every kind of secret <b>a team keeps.</b>', 'Ten groups, in one list, in the sidebar and in the Add picker. Adding an item shows the fields of the chosen provider in its own console&rsquo;s order.', 'v2-h')}
  <div class="pl-chips pl-chips-l rv">${['AI models', 'Email and sending', 'Phone and texts', 'Google and Microsoft', 'Code and hosting', 'Messaging', 'Logins', 'SSH keys', 'Secure notes', 'Any API key'].map(chip).join('')}</div>
  ${grid([
    ['Passwords and logins', 'A login holds a username, a password and a one-time code seed. An authenticator item holds a one-time code seed on its own.'],
    ['API keys and tokens', 'Personal access tokens, OAuth tokens with their refresh token and client secret, cloud keys and plain secrets. The Add picker knows the services a module may need and where to get each key.'],
    ['Cards and identities', 'A card keeps the number, holder, expiry, CVV and PIN. Identities and addresses keep the details a form asks for.'],
    ['Notes, files and licences', 'Secure notes, files, licence keys and Wi-Fi passwords sit next to the credentials they belong with.'],
    ['SSH keys and certificates', 'Private keys and certificates with their chain and passphrase, for the servers an agent deploys to.'],
    ['AI sign-ins', 'A member signs in to an AI provider with the provider&rsquo;s own sign-in and adds no API key as their own AI account.'],
    ['Connections', 'Mail, calendar and MCP connections are vault items too, with a health word: Healthy, Expiring, Expired or Unused.'],
    ['Member vaults', 'Each member has a vault of their own on the Space&rsquo;s server. The owner&rsquo;s vault is the Space&rsquo;s, and shared vaults between people have the roles admin, member and read-only.'],
  ])}
</div></section>

<section class="sec" id="keys" aria-labelledby="v3-h"><div class="wrap">
  ${head('How a secret is kept.', 'Sealed at rest, <b>with a key per item.</b>', 'The cryptography uses only the standard library of the runtime. Nothing here is a package you have to trust.', 'v3-h')}
  ${steps([['Master password plus Secret Key', 'Argon2id (or scrypt) turns the password into a key. The Secret Key is made with the account and shown once, for the recovery kit.'], ['The vault key', 'Opens the personal vault. A device key opens the agent vault.'], ['An item key', 'Each version of each item has its own key, wrapped under the vault key.'], ['AES-256-GCM', 'The value is sealed on disk. A change is a new version, so history is kept sealed too.']], 4)}
  ${facts([
    ['The server holds ciphertext only.', 'For a member vault, the member&rsquo;s own device supplies the Secret Key at each unlock.'],
    ['Sealing for another person.', 'An item can be sealed for another person&rsquo;s Vyre with X25519. Ed25519 signs relay requests.'],
    ['The Secret Key never lands in a log.', 'It appears in no event and no audit row. It is served once from loopback for the recovery kit.'],
    ['It locks itself.', 'After 10 minutes idle or 12 hours at most, and optionally on sleep or screen lock. All four are settings.'],
  ])}
</div></section>

<section class="sec" aria-labelledby="v4-h"><div class="wrap">
  ${head('Who can use what.', 'Sharing is a grant, <b>not a copy.</b>', 'A person, an agent and a task each get access the same way: a kernel grant on one item, ended by revoking it.', 'v4-h')}
  ${cols3([
    ['A person', 'Can use, without seeing it. Or Can edit, which also changes or replaces it. The grant is on one item and one current member, and ending it needs no one.'],
    ['An agent', 'Use only. It signs in on its own computer by driving the page, at one exact origin, until an expiry. It gets back <code>{ filled, origin, navigated, tab }</code> and never a field. A grant a model asks for waits for a person.'],
    ['A task', 'The Flows module lends the doer the Connections the task&rsquo;s approved Kit version names, use only, until a time, and takes them back when the task ends. Anything outward still waits for a yes.'],
  ])}
  ${facts([
    ['Reveal, copy and fill need a person.', 'A reveal stays up 60 seconds. A copied value leaves the clipboard after 30. One yes covers a reveal, copy or code for 5 minutes, on the same device and person.'],
    ['An agent is never &ldquo;you&rdquo;.', 'A model, module or guest cannot give the yes. The events record the field name, never the value.'],
    ['A module asks, the Vault answers.', 'A module calls the grant check, then asks for one field. It receives only a field it was granted.'],
    ['Taking access away is free.', 'Revoking needs no one. Granting from a model always waits.'],
  ])}
</div></section>

<section class="sec" aria-labelledby="v5-h"><div class="wrap">
  ${head('In the app.', 'The real screen, <b>with sample data.</b>', '', 'v5-h')}
  ${shot('vault.webp', 'The Vyre Vault screen. A list of items grouped by AI models, Code and hosting and Logins, and an open item showing a hidden value, who uses it and who has it. Sample data.', 'The Vault in the app. The value stays hidden until revealed, the item shows who uses it and who has it, and every use is logged. Sample data.')}
</div></section>

<section class="sec" aria-labelledby="v6-h"><div class="wrap feat"><div class="feat-copy rv">
  <span class="num">For agents</span>
  <h2 id="v6-h" class="h2">What an agent can ask, <b>and what only a person can do.</b></h2>
  <ul class="list">
    <li><b>Open to models</b><span>${code('vault.list')}, ${code('vault.item')}, ${code('vault.search')} and ${code('vault.history')} return names, kinds, field names and hosts. Never a value.</span></li>
    <li><b>Waits for a person</b><span>${code('vault.grant')} from a model becomes a request. ${code('vault.approve')} is a person&rsquo;s call.</span></li>
    <li><b>Person surfaces only</b><span>${code('vault.put')}, ${code('vault.reveal')}, ${code('vault.copy')}, ${code('vault.inject')}, ${code('vault.rotate')} and ${code('vault.access.set')} refuse a model.</span></li>
  </ul></div>
  <div class="mock rv"><div class="win" role="group" aria-label="The Vault module and its callers"><div class="win-bar"><i></i><i></i><i></i><span class="t">Callers and what they get</span></div><dl class="kv"><dt>A person</dt><dd>Reveal, copy and fill, on their own device, after a presence check</dd><dt>A module</dt><dd>One granted field, through the grant check</dd><dt>An agent</dt><dd>A use of one item, at one origin, until an expiry</dd><dt>A model</dt><dd>Names and kinds</dd></dl><div class="sysline">Events: ${code('vault.released')}, ${code('vault.filled')}, ${code('vault.refused')}, ${code('vault.lease-lent')}</div></div></div></div></section>

${nextBlock(['<b>0.6:</b> credentials lent to a woken agent for one job, use only, so an agent&rsquo;s task can carry the sign-in it needs and nothing else.'])}
${extend('Today, add the item as a login or API key and write a custom module that asks the Vault for it. The module never sees a value it was not granted.')}
${connects([
    ['/records/', 'Records', 'A sealed record field uses the same sealing process. A model sees a placeholder where the value is.'],
    ['/flows/', 'Flows', 'A Flow step lends a task its connections. A send that uses one waits for a yes.'],
    ['/agents/', 'Agents', 'An agent has a list of the Vault items its person gave it, use only.'],
    ['/architecture/#gate', 'The Gate', 'Where a held send that uses a credential waits for a person&rsquo;s yes.'],
    [doc('docs/architecture/features/vault.md'), 'Vault, in the repository', 'The feature page with every code path.'],
  ])}
${repoLinks([['core/vault/crypto.js', 'core/vault/crypto.js'], ['core/vault/access.js', 'core/vault/access.js'], ['core/vault/agent-fill.js', 'core/vault/agent-fill.js'], ['core/vault/people.js', 'core/vault/people.js'], ['lib/sealed.js', 'lib/sealed.js']])}
${closing}`;

  // ======================= RECORDS =======================
  const RECORDS = `${pageHead('records', 'Records', 'Records: <b>every kind of business object, linked into one graph.</b>',
    'A Space defines its own types, fields, groups and links, as many as its business needs. The kernel keeps the rows and judges every read and write, whether a person, an agent or a Flow makes it.',
    ['Any number of custom types', 'Links with named inverses', 'Link hops in tokens', 'Sealed fields', 'CSV and Excel in, CSV out'])}

${animSec('r1-h', 'A token hops the links', 'One token <b>reaches across your data.</b>',
    'A Link field points at another type. A token walks those links, so a task can print its client&rsquo;s phone without anyone copying it. Flows and Documents use the same tokens.',
    [['The shape is object, link, field', 'The nested form is ' + code('{object.link.field}') + ', as in ' + code('{project.client.phone}') + '. A token reaches up to three links deep.'], ['Links go both ways', 'A link to many records adds a named inverse field on the target, so a client lists its projects without a second definition.'], ['One copy of the truth', 'A phone changes in one record and every Flow and document that reads it prints the new number.']],
    ANIM_RECORDS, 'Animation: a token walks three linked records')}

<section class="sec" aria-labelledby="r2-h"><div class="wrap">
  ${head('What a type holds.', 'A flexible objects layer, <b>declared in data.</b>', 'A type is a row of its own kind, so a Space adds one in Settings, under Objects, without a developer. Every Space starts with the core types: contact, organization, task, project, event, template and the rest.', 'r2-h')}
  ${grid([
    ['Fields, twenty kinds', 'Text, rich text, number, money, boolean, date, date and time, choice, multi-choice, rating, URL, link, actor, file, address, phones, emails, URLs, stage and sealed.'],
    ['Field switches', 'Required, unique, hidden (the data stays), hidden from named roles, visible if, required if, computed, and a group.'],
    ['Groups', 'Fields sit in groups on the record page, so a long type stays readable.'],
    ['Links and inverses', 'One type links to another, one or many. Links chain: a task to a project, the project to a client, the client to an organization.'],
    ['Stage sets', 'One type can follow several tracks. While a condition on a record holds, it follows that set of stages. The first set that holds wins.'],
    ['Views', 'A type stores its own views: list, board, calendar, page or dashboard, with columns, grouping, a filter and a sort. Pin one to the sidebar.'],
    ['Sealed fields', 'A field that holds a reference, not the value. A model sees whether it is present and valid, never what it says.'],
    ['Tags, import, export', 'A # in the chat composer puts a record, a whole object or a template&rsquo;s projects in front of the AI. Import takes CSV or Excel. The web app exports CSV.'],
  ])}
</div></section>

<section class="sec" id="model" aria-labelledby="r3-h"><div class="wrap">
  ${head('The data model.', 'Types, links and totals, <b>in one diagram.</b>', 'A type definition holds fields, stages, stage sets, views, rules and groups. A role on a type, such as client or prospect, says it points at a contact or organization. The types below are an example.', 'r3-h')}
  <div class="pl-diagram rv">${GRAPH_RECORDS}</div>
  ${facts([
    ['Stage sets pick the track.', 'A residential-job track and a commercial-job track can live on one type, chosen by a field on each record. The stage field offers every stage name across the sets.'],
    ['A computed field can total.', 'It can sum the records that link to it, such as the fees of every project of a client.'],
    ['Kits bring a starting point.', 'A Kit adds types, Flows and Playbooks for a kind of business. A person adds their own in Customize.'],
    ['Edits do not collide.', 'An update carries the version it read, and a stale one is refused as a version conflict.'],
  ])}
</div></section>

<section class="sec" id="check" aria-labelledby="r4-h"><div class="wrap">
  ${head('How access is decided.', 'The kernel judges <b>every call.</b>', 'The records tool opens a door that builds the caller&rsquo;s own chain in the Space the call names. A person in the app, an agent in a session and a Flow step go through the same check.', 'r4-h')}
  ${steps([['The caller', 'A person, an agent or a Flow step names a records tool.'], ['The door', 'Builds the chain from facts the daemon verified itself.'], ['The kernel checks', 'The action (read, create, update, remove, restore, define), the role, which roles may see a field, sealed fields and rules.'], ['The gateway writes', 'One gateway handles every record read and write, and keeps links and inverses in step.'], ['The log', 'Each change is an event with who, what, when and the chain.']], 5)}
  ${facts([
    ['A hidden field is hidden from the call, not the screen.', 'A role in a field&rsquo;s hidden-from list never receives that field, from the app or from an agent.'],
    ['Deletion has two doors.', 'Remove sends a record to the Bin and restore brings it back. Forget destroys a record, its history and its sealed values, needs a person&rsquo;s presence, and an agent can only propose it, which makes a task.'],
    ['Module-kept types stay private.', 'Types that a module keeps, such as skills and chat records, are open to that module and to owners and admins.'],
    ['A team member reaches the team&rsquo;s server.', 'Member calls pass through a door that refuses any other caller and strips keys a member may not send.'],
  ])}
</div></section>

<section class="sec" id="sealed" aria-labelledby="r5-h"><div class="wrap">
  ${head('Sealed fields.', 'A secret in a record, <b>that a model cannot read.</b>', '', 'r5-h')}
  ${steps([['A person enters the value', 'The sealing process receives it. The record keeps only a reference.'], ['A model reads the record', 'It sees whether the field is present and valid, and a placeholder where the value would be.'], ['An outward call names the field', 'The kernel resolves the placeholder only inside that call, under the asking person&rsquo;s chain.'], ['A person says yes', 'The call is held for approval. Revealing the value on screen is a separate act that needs fresh presence.']], 4)}
</div></section>

<section class="sec" aria-labelledby="r6-h"><div class="wrap">
  ${head('In the app.', 'The Records screen, <b>with sample data.</b>', '', 'r6-h')}
  ${shot('records.webp', 'The Vyre Records screen listing six contacts with role, email and phone, a search box, a Filter button, Import, Export CSV, New view and a List and Board switch. Sample data.', 'One type as a List. Switch to Board, add a view, import a spreadsheet or export CSV from the same screen. Sample data.')}
</div></section>

<section class="sec" aria-labelledby="r7-h"><div class="wrap feat"><div class="feat-copy rv">
  <span class="num">For agents</span>
  <h2 id="r7-h" class="h2">An agent works with records <b>as the person it works for.</b></h2>
  <ul class="list">
    <li><b>Read and write within the grants</b><span>${code('records.list')}, ${code('records.get')}, ${code('records.create')}, ${code('records.update')}, ${code('records.linked')} and ${code('records.reference')} run as the person, within that person&rsquo;s access.</span></li>
    <li><b>Set it up with your AI</b><span>An AI a person connects over MCP works through the same door and checks as the app, so the kernel decides what it may define. The Engineer, a built-in agent, proposes changes and applies none.</span></li>
    <li><b>The person&rsquo;s own acts</b><span>${code('records.reveal')}, ${code('records.seal-put')} and ${code('records.forget')} stay with a person. An agent proposes a forget.</span></li>
  </ul></div>
  <div class="mock rv"><div class="win" role="group" aria-label="Import in four steps"><div class="win-bar"><i></i><i></i><i></i><span class="t">Import</span></div><dl class="kv"><dt>1</dt><dd>Pick a CSV, an Excel sheet or paste rows</dd><dt>2</dt><dd>Match each column to a field</dd><dt>3</dt><dd>Every row is checked before it is added</dd><dt>4</dt><dd>Rows are added one by one through the same create a form uses</dd></dl><div class="sysline">A row that matches an existing record is skipped or added anyway, as the person picks.</div></div></div></div></section>

${nextBlock(['<b>0.6:</b> per-record privacy for the types you define, and write-once fields.'])}
${extend('Today, for behaviour a type cannot hold, such as a nightly rollup or a check against an outside list, a custom module adds a tool on your records.')}
${connects([
    ['/flows/', 'Flows', 'A record created, changed or entering a stage starts a Flow. Steps find, create, update and move records.'],
    ['/agents/', 'Agents', 'An agent is a record-keeping teammate too: it reads and writes as its person.'],
    ['/vault/', 'Vault', 'Sealed fields use the same sealing process as vault items.'],
    ['/architecture/#call', 'How a call flows', 'The door, the chain and the check every records call goes through.'],
    [doc('docs/architecture/features/records.md'), 'Records, in the repository', 'The feature page with every code path.'],
  ])}
${repoLinks([['kernel/gateway/records.js', 'kernel/gateway/records.js'], ['kernel/gateway/links.js', 'kernel/gateway/links.js'], ['kernel/contracts/fields.d.ts', 'kernel/contracts/fields.d.ts'], ['lib/sealed.js', 'lib/sealed.js'], ['kernel/core/fields.js', 'kernel/core/fields.js']])}
${closing}`;

  // ======================= FLOWS =======================
  const FLOWS = `${pageHead('flows', 'Flows', 'Flows: <b>work that runs the same way every time.</b>',
    'A Flow is a stored list of steps that starts from a trigger and runs under an approver&rsquo;s authority. It stops for a person wherever a send, a question or a task needs one.',
    ['Five kinds of trigger', 'Approved by a person before it runs', 'Versioned, with a way back', 'Replay-safe, step by step'])}

${animSec('f1-h', 'A Flow, running', 'A trigger fires, the steps run, <b>and a person holds the send.</b>',
    'A Flow is a trigger and a list of steps, kept as structured data. Each step goes through the kernel as the approver&rsquo;s own narrowed chain, so a Flow reaches no more than the person who approved it.',
    [['It waits where it should', 'A step can ask a person or a role and stop the run until they answer. A send over a limit, or to a recipient taken from outside content, is held for a yes.'], ['It hands work to agents', 'A &ldquo;Hand to an agent&rdquo; step becomes a task for the named agent, which wakes with the task and the record.'], ['It explains itself', 'Every run has a page with each step&rsquo;s status, when a wait wakes and who approved the version.']],
    ANIM_FLOWS, 'Animation: a Flow with an approval hold')}

<section class="sec" aria-labelledby="f2-h"><div class="wrap">
  ${head('What starts one, and what it does.', 'Five triggers, <b>twenty-two kinds of step.</b>', '', 'f2-h')}
  ${grid([
    ['A person', 'Someone, or an assistant, runs it with one call.'],
    ['A schedule', 'A cron line, an interval of at least a minute, or a single time, read in the Space&rsquo;s time zone, with business hours, holidays and a choice for what to do after downtime.'],
    ['A record', 'A record created, updated or removed, optionally one changed field or a condition. Or a record entering a named stage.'],
    ['A form or a call', 'A form submission, or an inbound call to the Flow&rsquo;s own path.'],
    ['A watcher', 'Something new in a watched place, such as a mailbox or a folder.'],
    ['Logic and records', 'If and else, for each, side by side, wait, wait for someone&rsquo;s yes. Find, look up, filter, create, update, find or create, remove, move to a stage.'],
    ['Send, AI and work', 'Send an email or a text. Call a web address. Hand to an agent, sort into groups, pull out facts. Assign a task, start a project, run another Flow.'],
    ['Tokens', 'Text takes values such as ' + code('{client.first_name}') + ', ' + code('{today}') + ' and ' + code('{project.client.phone}') + ', with an offset and a format. Expressions are parsed, never run as code.'],
  ])}
</div></section>

<section class="sec" id="runner" aria-labelledby="f3-h"><div class="wrap">
  ${head('How a run is made safe.', 'Approved, replayable, <b>and limited to one person&rsquo;s reach.</b>', 'The runner is part of the kernel. Five facts keep a Flow from doing more than the person who approved it.', 'f3-h')}
  ${steps([['A trigger arrives', 'The run id is a hash of the Flow and the trigger key, so a trigger delivered twice is one run.'], ['An approved version', 'A definition never changes. An edit is a new version with a hash, and approval binds that version to the approver.'], ['The approver&rsquo;s chain', 'Each effect step is checked against the Flow&rsquo;s declared caps, then authorized as the automation and the approver together.'], ['A ledger', 'Each step is written before and after it acts, keyed by run, step and loop index. The key doubles as the idempotency key.'], ['A held act', 'A send that needs a person becomes a task. The person&rsquo;s decision gives a single-use approval for exactly that act.']], 5)}
  ${facts([
    ['Versions with a way back.', 'Roll back to an earlier version and the person is asked again. Nothing carries over from the old approval. A saved test case that fails blocks approval.'],
    ['One yes covers a bounded send.', 'An approved version carries a yes for its destinations and limits, up to a count and a rate per minute. Beyond that, a person is asked.'],
    ['Untrusted input is marked.', 'A run started by or reading outside content is tainted, and its outward and grant steps ask a person.'],
    ['A lost grant pauses the Flow.', 'If the approver loses access, the Flow pauses with the reason instead of running as someone else.'],
    ['Loops are bounded.', 'At most 200 steps, 6 levels of nesting and 1000 repeats. A runaway pauses the Flow and raises a card.'],
    ['A switch for all of it.', 'Pause with all or drain holds new triggers in order. Resume runs them, or drops them.'],
  ])}
</div></section>

<section class="sec" id="tracks" aria-labelledby="f4-h"><div class="wrap">
  ${head('Tracks.', 'One record type, <b>one Flow per kind of work.</b>', 'A type can follow several tracks through stage sets. Write one Flow for each, with a record trigger whose condition names the track, and each Flow runs only for its own records.', 'f4-h')}
  ${cols3([['Track A', 'A record trigger with the condition that the practice area equals the first track, and its own stages and tasks.'], ['Track B', 'The same trigger with the second track&rsquo;s condition. Same records, its own Playbook and Flows.'], ['Failure paths', 'A step can retry named transient errors, run its own on-failure steps, and the whole Flow can run steps such as a task for the partner when a run fails.']])}
</div></section>

<section class="sec" aria-labelledby="f5-h"><div class="wrap">
  ${head('In the app.', 'The Flows screen, <b>with sample data.</b>', '', 'f5-h')}
  ${shot('flows.webp', 'The Vyre Flows screen listing flows in groups called Clients, Money and Operations. Each flow reads as a plain sentence, such as when a matter enters Intake, assign the intake agent to collect the facts, then wait, then set the stage to Engagement. Sample data.', 'Each Flow reads as a sentence. The builder, the code view, a Versions list and Run history sit one click in. Sample data.')}
</div></section>

<section class="sec" aria-labelledby="f6-h"><div class="wrap feat"><div class="feat-copy rv">
  <span class="num">For agents</span>
  <h2 id="f6-h" class="h2">An agent can draft a Flow. <b>Nothing runs until a person approves.</b></h2>
  <ul class="list">
    <li><b>Open to models</b><span>${code('flows.define')}, ${code('flows.propose')}, ${code('flows.simulate')}, ${code('flows.start')}, ${code('flows.get')}, ${code('flows.runs')}, ${code('flows.health')} and ${code('flows.from-chat')} run under the caller&rsquo;s own chain.</span></li>
    <li><b>Person only</b><span>${code('flows.approve')} also asks for presence. Rollback, pause, resume and access are a person&rsquo;s too.</span></li>
    <li><b>The Engineer helps</b><span>Describe a Flow in plain words and the Engineer drafts it, simulates it and proposes it. A person&rsquo;s yes applies it.</span></li>
  </ul></div>
  <div class="mock rv"><div class="win" role="group" aria-label="Events a run emits"><div class="win-bar"><i></i><i></i><i></i><span class="t">Events the runner emits</span></div><dl class="kv"><dt>Starts</dt><dd>flow.started, flow.queued</dd><dt>Ends</dt><dd>flow.finished, flow.cancelled</dd><dt>Trouble</dt><dd>flow.paused, flow.stale, flow.stuck, flow.retried</dd></dl><div class="sysline">Each run is a record of its own, so it keeps history, grants and audit.</div></div></div></div></section>

${nextBlock(['<b>0.6:</b> a due time on an agent step with a failure path, and a failure panel on every step in the editor.', '<b>0.6:</b> CC, BCC and attachments on a Flow email, with date helpers.'])}
${extend('Today, a Flow web step calls an outside API with a connection from the Vault. When the palette lacks a step, a custom module adds a tool that a Flow calls with a call step.')}
${connects([
    ['/records/', 'Records', 'Triggers and steps read and write records. A Flow and a type share the same tokens.'],
    ['/agents/', 'Agents', 'A Hand to an agent step becomes a task that wakes the agent.'],
    ['/vault/', 'Vault', 'A task can borrow the connections its approved version names, use only.'],
    ['/architecture/#gate', 'The Gate', 'A held send is a task. A person reads the exact words and approves once.'],
    [doc('docs/architecture/features/flows.md'), 'Flows, in the repository', 'The feature page with every code path.'],
  ])}
${repoLinks([['kernel/flows/runner.js', 'kernel/flows/runner.js'], ['kernel/flows/schema.js', 'kernel/flows/schema.js'], ['kernel/flows/triggers.js', 'kernel/flows/triggers.js'], ['kernel/flows/standing.js', 'kernel/flows/standing.js'], ['core/daemon/agent-wake.js', 'core/daemon/agent-wake.js']])}
${closing}`;

  // ======================= AGENTS =======================
  const AGENTS = `${pageHead('agents', 'Agents', 'Agents: <b>named teammates that wake on a task.</b>',
    'An agent is a named, persistent helper with its own instructions, memory, context and access. People chat with it, assign it tasks and use it in Flows. It finishes a task, hands it on, or says it is stuck.',
    ['Instructions in AGENTS.md', 'Memory that becomes instructions', 'Shared as Can use or Can edit', 'Never more reach than its person'])}

${animSec('a1-h', 'A task wakes an agent', 'A task arrives. <b>The agent finishes it or says why it cannot.</b>',
    'When a ready task has an agent as its doer, Vyre wakes the agent with that task, its record and the Flow it came from. It is never left open in silence.',
    [['One job thread for each task', 'A claim in its own table stops a restart from starting a second one. The thread id is written on the task.'], ['The agent starts and submits', 'The wake never marks the task done. The agent does, and the kernel checks the output.'], ['Stuck has a reason', 'If the agent cannot start, or ends with the task still open, the task is marked stuck with a plain reason and a suggested fix. Secret-looking strings are cut from the reason.']],
    ANIM_AGENTS, 'Animation: a task wakes an agent')}

<section class="sec" aria-labelledby="a2-h"><div class="wrap">
  ${head('What an agent has.', 'A folder, a memory, <b>and a list of what it may use.</b>', 'An agent is a folder with its instructions, a memory of what it learned, its own context files and the Vault items its person gave it.', 'a2-h')}
  ${grid([
    ['Instructions', 'AGENTS.md, with a CLAUDE.md beside it that points at it, written fresh at every launch. Each edit is a version and applies from the next turn.'],
    ['Memory', 'Each row is a Fact, a Note, a Decision or a Lesson, with its source. A lesson has a button, Make it an instruction, and then it sits in AGENTS.md.'],
    ['Context', 'Uploaded files and linked folders the agent reads when it works.'],
    ['Vault items', 'A list of items the agent may use without seeing the value.'],
    ['Sharing', 'Share an agent as Can use or Can edit, the same two words the Vault and Flows use. Only the creator, an owner or an admin shares.'],
    ['Project reach', 'An agent has a list of projects, or all. Work outside that list fails with a plain denial that says the person must give it that project first.'],
    ['What my assistant may do', 'A person turns areas and tools off for their own assistant, so its reach is set by the person, in one screen.'],
    ['Teammates and duties', 'A project can hold one agent per role, each with its own notes. A duty runs on an event or a schedule, and a duty an agent proposes for itself stays off until a person turns it on.'],
  ])}
</div></section>

<section class="sec" id="wake" aria-labelledby="a3-h"><div class="wrap">
  ${head('How the wake works.', 'The kernel log wakes it. <b>The task bounds it.</b>', 'A watcher subscribes to the kernel&rsquo;s log. It acts on a task that was created, made ready or unblocked.', 'a3-h')}
  ${steps([['A task event', 'task.created, task.readied or task.unblocked appears in the log.'], ['The check', 'The task is ready, its doer is an agent, it was not made by hand, it is not a follower&rsquo;s note, and it is under a day old.'], ['One use lent', 'The agent is lent use of that one task, and nothing else.'], ['One job thread', 'The agent&rsquo;s own session starts with the task, its record and where it came from.'], ['It ends', 'Done, handed on, or stuck. The lent use is taken back when the task completes, is approved, rejected, skipped or voided.']], 5)}
  ${facts([
    ['The chain is the person, then the agent.', 'Its authority is the intersection of their grants, so an agent never has more than the person who started it.'],
    ['Wake tools are closed to models.', 'The calls that wake, record or fail a job are marked for modules only, so no model can call them.'],
    ['An agent cannot read another agent.', 'Files, context, sharing and the vault list of an agent refuse an agent, model or MCP caller.'],
    ['Held acts go through the Gate.', 'A send or a payment from an agent is requested and a person approves it.'],
  ])}
</div></section>

<section class="sec" aria-labelledby="a4-h"><div class="wrap">
  ${head('In the app.', 'The Agents screen, <b>with sample data.</b>', '', 'a4-h')}
  ${shot('agents.webp', 'The Vyre Agents screen. Four agents called juno, kit, intake and refunds, each showing a role and a model, and one agent shared with the person as Can use. Sample data.', 'Your assistant, a research agent, an intake agent, a refunds agent and one shared by a teammate. Each has its own instructions, memory and access. Sample data.')}
</div></section>

<section class="sec" aria-labelledby="a5-h"><div class="wrap feat"><div class="feat-copy rv">
  <span class="num">For agents</span>
  <h2 id="a5-h" class="h2">An agent can make agents, <b>within its own reach.</b></h2>
  <ul class="list">
    <li><b>Open to agents</b><span>${code('agents.list')}, ${code('agents.create')}, ${code('agents.update')}, ${code('agents.ask')} and ${code('agents.rollover')}, each bounded by the caller&rsquo;s grants.</span></li>
    <li><b>Short-lived helpers</b><span>${code('agents.spawn')} starts a helper that works as you, with your access or less.</span></li>
    <li><b>Outside AI tools</b><span>An AI a person connects over MCP comes in through the same door, as that person and within its key&rsquo;s reach. Sends still wait at the Gate.</span></li>
  </ul></div>
  <div class="mock rv"><div class="win" role="group" aria-label="Where an agent&rsquo;s instructions live"><div class="win-bar"><i></i><i></i><i></i><span class="t">An agent&rsquo;s folder</span></div><dl class="kv"><dt>AGENTS.md</dt><dd>Its instructions, versioned</dd><dt>CLAUDE.md</dt><dd>A pointer, written at each launch</dd><dt>Memory</dt><dd>Facts, notes, decisions, lessons</dd><dt>Context</dt><dd>Files and linked folders</dd></dl><div class="sysline">A session starts in this folder, and Claude Code and Codex read it natively.</div></div></div></div></section>

${nextBlock(['<b>0.6:</b> a due time and a failure path on agent steps, so a Flow can route around an agent that has not answered.', '<b>0.6:</b> credentials lent to a woken agent for one job, use only.'])}
${extend('Today, a custom module adds what the built-in agents lack, and a Flow step or a Vault connection reaches the outside system.')}
${connects([
    ['/flows/', 'Flows', 'A Hand to an agent step makes the task that wakes it. Flows read and write the same tasks.'],
    ['/records/', 'Records', 'An agent reads and writes records as its person, and never sees a sealed value.'],
    ['/vault/', 'Vault', 'An agent uses a credential without reading it, at one site, until an expiry.'],
    ['/architecture/#turn', 'How an agent&rsquo;s turn runs', 'Model routing, the session driver and tool calls back through the door.'],
    [doc('docs/architecture/features/agents.md'), 'Agents, in the repository', 'The feature page with every code path.'],
  ])}
${repoLinks([['core/agents/index.js', 'core/agents/index.js'], ['core/daemon/agent-wake.js', 'core/daemon/agent-wake.js'], ['core/agents/config.js', 'core/agents/config.js'], ['kernel/tasks/tasks.js', 'kernel/tasks/tasks.js']])}
${closing}`;

  const mk = (slug, name, title, desc, ogTitle, ogSub, body, out) => ({
    slug, path: `/${slug}/`, title, desc, ogTitle, ogSub, body,
    ld: [crumbs([['Vyre', `${SITE}/`], ['Architecture', `${SITE}/architecture/`], [name, `${SITE}/${slug}/`]])],
    out,
  });
  return [
    mk('vault', 'Vault', 'Vyre Vault: secrets an agent can use and never read', 'How the Vyre Vault keeps passwords, keys and sign-ins sealed, shares them by grant, lease or use-only pass, and lets an agent use a credential without a model ever seeing it.', 'The Vault: use it, never read it.', 'Sealed at rest, shared by grant, and released at send time.', VAULT),
    mk('records', 'Records', 'Vyre Records: any business object, linked into one graph', 'How Vyre Records works: custom types, fields, groups, links with inverses, link hops in tokens, stage sets, views, sealed fields, and CSV and Excel import, judged by the kernel on every call.', 'Records, linked into one graph.', 'Custom types, links with inverses, tokens that hop links.', RECORDS),
    mk('flows', 'Flows', 'Vyre Flows: work that runs the same way every time', 'How Vyre Flows runs: five trigger kinds, versioned and approved definitions, a replay-safe runner, approval holds for anything that leaves, and agent steps that wake an agent.', 'Flows that run the same way every time.', 'Triggers, approved versions, a ledger and a hold for a yes.', FLOWS),
    mk('agents', 'Agents', 'Vyre Agents: named teammates that wake on a task', 'How Vyre Agents works: instructions, memory, context and access for each agent, sharing as Can use or Can edit, and a task that wakes an agent to finish, hand on or mark stuck.', 'Agents that wake on a task.', 'Instructions, memory, access, and a task that finishes or says stuck.', AGENTS),
  ];
}

// Lines the machine-readable files carry for these pages.
export const PILLAR_LLMS = (SITE) => [
  `- [Vault](${SITE}/vault/): how credentials are sealed, shared by grant, lease or use-only pass, and used by agents without a model seeing a value`,
  `- [Records](${SITE}/records/): custom types, links with inverses, link hops in tokens, stage sets, views, sealed fields, import and export`,
  `- [Flows](${SITE}/flows/): triggers, approved versions, the replay-safe runner and holds for a person`,
  `- [Agents](${SITE}/agents/): instructions, memory, access, and how a task wakes an agent that finishes, hands on or says stuck`,
];
