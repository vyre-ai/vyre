// scripts/site/computer.mjs: the Vyre Computer section of vyre.run (/computer/, /computer/chrome/, /computer/architecture/).
//
// gen-site.mjs imports this and calls computerPages({...helpers}) for the page specs it hands to page(), plus COMPUTER_LLMS and COMPUTER_FULL for
// llms.txt and llms-full.txt. The classes are cp-* (and the ar-* ones the architecture page already uses) in site/v2.css.
//
// Every claim here is checked against source: local/hands-chrome-mac (the Chrome control: oversight.js, index.js, extension/caps/api.js,
// extension/shared/outbound.js, standalone/), modules/vault-extension, core/computer, core/computers, core/runner, docs/using/computer.md,
// docs/using/connectors.md, roadmap/0.7.md and docs/known-gaps.md. A planned capability is labelled Next, with its version where the roadmap gives one.

const GH = (REPO, p) => `${REPO}/blob/main/${p}`;

const li = (items) => `<ul class="cp-list">${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;
const node = (n, t, d) => `<li class="ar-node"><span class="ar-n">${n}</span><b>${t}</b><span>${d}</span></li>`;
const card = (t, d, extra = '') => `<div class="piece cp-piece"><h3>${t}</h3><p>${d}</p>${extra}</div>`;
const next = (v) => `<span class="chip-next">${v ? `Coming in ${v}` : 'Coming next'}</span>`;
const pre = (s) => `<pre class="cp-pre"><code>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;

function connects(REPO, SITE, items) {
  return `<section class="sec cp-conn" aria-labelledby="conn-h"><div class="wrap">
    <div class="note rv"><p class="lbl" id="conn-h" style="margin-bottom:10px">Connects to</p>
    <ul class="cp-links">${items.map(([href, t, d]) => `<li><a href="${href}"><b>${t}</b></a><span>${d}</span></li>`).join('')}</ul></div>
  </div></section>`;
}

export const COMPUTER_LLMS = (SITE) => `## Vyre Computer
- [Vyre Computer](${SITE}/computer/): how agents work on real computers: your Chrome, your Mac and computers of their own, with logins from the Vault and every send held at the Gate
- [Vyre for Chrome](${SITE}/computer/chrome/): what it does today and how to install it, standalone for Claude Code or native inside Vyre, plus the Vault fill extension
- [Chrome control, architecture](${SITE}/computer/architecture/): how it drives a site through the site's own API calls, remembers how each site works, plans, holds sends for approval, stops on Esc and logs
`;

export const COMPUTER_FULL = (SITE, REPO) => `## Vyre Computer
- Vyre Computer is how an agent uses a browser, a desktop or an app when no cleaner way exists: ${SITE}/computer/. It tries the site's own interface first and the screen last. Logins are filled by the Vault, so the model never sees a password. Anything that sends, posts or pays waits for a person.
- Vyre for Chrome drives the Chrome you already have open, signed in as you: ${SITE}/computer/chrome/. It runs two ways. Standalone, it is an MCP server plus a Chrome extension for Claude Code with no Vyre server (command: vyre-chrome; build it from ${REPO}/tree/main/local/hands-chrome-mac/standalone). Native, it is the same code inside Vyre on a Mac, where a held send becomes a card in Needs you. The Vault fill extension (modules/vault-extension) fills logins, passkeys and one-time codes from your Vault in Chrome, Arc, Edge, Brave and Firefox.
- How Chrome control works is written as an engineering document at ${SITE}/computer/architecture/: a read is tried through the site's own API call (learned from the page's traffic, called from inside the page with your login); the page is the fallback; DevTools and a screenshot come after. It remembers each site's structure (never a value) and reuses it. An agent posts its plan first. A send, post or payment is held and re-checked against the page before it goes. Esc stops everything. Every session writes a masked local log.
- Computer use today: one front door (computer.use) over your Chrome, your Mac (through the accessibility tree) and a computer of each agent's own on your server (a desktop, Chrome and a terminal, with a home folder that survives restarts); a Vault sign-in the agent never sees; take-over by a person; a computer you lend to a Space runs its sessions in a sandbox with an encrypted workspace.
- Next (direction, not dates): one Chrome extension that signs in like a device of yours (0.7), Chrome control for chats (0.7), a chat in the browser side panel (0.7), Screen Share on every device, driving a connected computer from your phone, agents borrowing a computer from the Space's pool, and a Chrome profile per agent.
`;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// /computer/
// ---------------------------------------------------------------------------------------------------------------------------------------------
function overview({ SITE, REPO, MAP_URL, eyebrow, crumbs }) {
  const body = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Computer</p>
    ${eyebrow('Vyre Computer.')}
    <h1 class="display">Agents that work <b>on real computers.</b></h1>
    <p class="lead">Some work has no API: a portal, a government site, a back-office page, a desktop app. Vyre Computer is how an agent does that work. It tries the site’s own interface first, uses the screen last, signs in without seeing a password, and stops at anything that sends, posts or pays until a person approves it.</p>
    <div class="btn-row"><a class="btn btn-fill" href="/computer/chrome/">Install Vyre for Chrome</a><a class="btn" href="/computer/architecture/">Read how it works</a></div>
  </div>
</section>

<section class="sec" id="places" aria-labelledby="places-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('One front door.')}
      <h2 id="places-h" class="h2">Three places to work, <b>named the way you would say them.</b></h2>
      <p class="lead">An agent asks for a computer by name: “on my Mac”, “on the office computer”. With no name it uses its own. If a name fits two computers or none, it asks you, with the real names as choices. It never guesses.</p>
    </div>
    <div class="cp-cards rv">
      ${card('Your Chrome', 'The Chrome you already have open, signed in as you. <b>Vyre for Chrome</b> reads a page in one call, fills forms, runs a whole workflow build as one batch and reads DevTools. It works in Chrome, Brave, Edge, Chromium, Arc and Dia.', '<p><a class="cp-more" href="/computer/chrome/">Install it and see what it does</a></p>')}
      ${card('Your Mac', 'Computer use on macOS reads and presses controls in any app through the accessibility tree. An agent on your server works on your Mac only for the kinds of work you allow there: <code>look</code>, <code>act</code> and <code>files</code>. Each is off until you turn it on and one command takes it back.', `<p><a class="cp-more" href="${GH(REPO, 'docs/using/computer.md')}">Read Vyre Computer in the docs</a></p>`)}
      ${card('An agent’s own computer', 'A container on your server with a desktop, Chrome and a terminal. Each agent has its own, with its own home folder and Chrome profile. A few screens are shared: a computer runs only while someone is looking at it, and is frozen when idle.', `<p><a class="cp-more" href="${GH(REPO, 'docs/using/agents.md')}">Give an agent a computer</a></p>`)}
    </div>
  </div>
</section>

<section class="sec" id="ladder" aria-labelledby="ladder-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Interface first, screen last.')}
      <h2 id="ladder-h" class="h2">Five ways to do a thing, <b>cheapest and surest first.</b></h2>
      <p class="lead">Clicking pixels is slow and breaks when a page changes. Vyre Computer climbs down a ladder instead. A failure on one rung names the next. When the same target fails twice on the page rungs, the error comes back with a fresh screenshot and the next step already named.</p>
    </div>
    <ol class="cp-ladder rv">
      <li><span class="ar-n">1</span><b>The site’s own API call</b><span>Learned from the page’s traffic and called from inside the page with your login. A read tries this first.</span></li>
      <li><span class="ar-n">2</span><b>The page’s controls</b><span>Found by role, name and identifier on a fresh look at the page, in every frame.</span></li>
      <li><span class="ar-n">3</span><b>DevTools</b><span>DOM, console, network and scripts, to see why a control did not answer.</span></li>
      <li><span class="ar-n">4</span><b>The accessibility tree</b><span>The control by its role and name, where the page markup is unhelpful.</span></li>
      <li><span class="ar-n">5</span><b>The screen</b><span>A screenshot and a point in it. The last rung, for a canvas or a frame it cannot read.</span></li>
    </ol>
    <p class="cp-foot rv">Before any of this, <code>computer.use</code> checks for a Connection you made or an operation Vyre learned from the site. If one covers the job, the screen is not touched. Say “do it on screen” and it goes straight there.</p>
  </div>
</section>

<section class="sec" id="plugs" aria-labelledby="plugs-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Part of Vyre, not beside it.')}
      <h2 id="plugs-h" class="h2">It plugs into the Vault, <b>Agents, Flows, Needs you and the Gate.</b></h2>
    </div>
    <div class="cp-cards cp-cards5 rv">
      ${card('Vault', 'Logins are filled without the model seeing them. Tag a login with <code>#Name</code> and the Vault types the username, password and one-time code into the agent’s computer. While it does, the agent’s hands refuse every read and input, and the fill ends on its own within a minute. Your own Chrome is never typed into by Vyre: you type, or the Vault’s fill extension does, with Touch ID.')}
      ${card('Agents', 'Each agent has its own computer and can start, stop and read only that one. A named agent holds a grant from you. In Chrome it posts its plan before its first action, and you can interject, edit a step that has not started, or stop it.')}
      ${card('Flows', 'Teach Vyre a site once and make it a Connection. A Flow’s “Call a service” step then runs the site’s operations with no model in the loop, and anything that is not a read is held. A public-records search can run on a schedule this way.')}
      ${card('Needs you', 'A held act is a card with the site, the control and the field values it would send. When a site’s login runs out, one quiet card says “Sign in to the site again” and closes itself when the site answers.')}
      ${card('The Gate', 'A send, a post, a payment or a delete made through a computer waits at the Gate. An agent can ask and cannot approve. If the page changed since the act was held, the release is refused and nothing happens.')}
    </div>
  </div>
</section>

<section class="sec" id="today" aria-labelledby="today-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('What is built.')}
      <h2 id="today-h" class="h2">Today, <b>in code and under test.</b></h2>
    </div>
    <ul class="list rv">
      <li><b>Vyre for Chrome, two ways to run it</b><span>Standalone for Claude Code, and native inside Vyre. CI drives a real Chrome on macOS, Windows and Linux. <a href="/computer/chrome/">Install steps and capabilities</a>. <a href="/computer/architecture/">The architecture</a>.</span></li>
      <li><b>Computer use on a Mac</b><span>Accessibility-tree control of any app. A visible indicator shows while it acts and no setting removes it. An agent’s send is held for your yes.</span></li>
      <li><b>A computer for each agent</b><span>A container with a desktop, Chrome and a terminal. Its home folder and Chrome profile survive a restart. Limits are set per agent: <code>vyre agents computer kit limits --cpus 2 --memory 4</code>.</span></li>
      <li><b>Take-over</b><span>A person takes the keyboard and the agent’s hands refuse input until the person gives it back. A person signing in privately also blinds the agent: its reads are refused too.</span></li>
      <li><b>Lending a computer to a Space</b><span>A member lends a Mac or Linux computer. The Space’s sessions run there inside a sandbox (macOS seatbelt, Linux bubblewrap) whose network reaches only the AI provider and the Space, in an encrypted workspace that opens while the Space leases its key (one hour, renewed while access holds). Either side takes it back in one tap. A session moves to the server when the lid closes.</span></li>
      <li><b>Sign-in handed to the Vault</b><span>The agent says <code>computer.use { do: "signin", login }</code> and never receives the login. When you turn egress on, chosen sites (a bank, a tax authority) leave through your own Mac so they see your address, and fail closed if the Mac is away.</span></li>
    </ul>
  </div>
</section>

<section class="sec" id="next" aria-labelledby="next-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Where it goes.')}
      <h2 id="next-h" class="h2">Drive any connected computer, <b>from wherever you are.</b></h2>
      <p class="lead">The pieces for this are already in place: a Space’s server that holds the Gate and the Vault, computers that join it, a phone that approves with Face ID or a fingerprint, and a placement step that decides where work runs. The next steps extend that picture. They are direction, not dates.</p>
    </div>

    <div class="cp-pool rv" role="group" aria-label="The device pool. On the left, where you ask from: the Vyre app on a Mac or Windows PC, and a phone. In the middle, your Space’s server, which holds the Gate, Needs you, the Vault, agents and Flows, the pool of screens and placement. On the right, the computers that do the work: agent computers, your Mac, a computer you lend, and, Next, any connected device that is awake.">
      <div class="cp-col">
        <p class="ar-tag">Where you ask from</p>
        <div class="ar-box"><b>The Vyre app</b><span>Mac and Windows. Ask an agent, watch its plan, approve at the Gate.</span></div>
        <div class="ar-box"><b>Your phone</b><span>Approve with Face ID or a fingerprint. Answer Needs you.</span></div>
        <div class="ar-box ar-dash">${next()}<b>Drive a computer from your phone</b><span>Ask for a screen of any awake connected device and work in it.</span></div>
      </div>
      <i class="cp-arrow" aria-hidden="true"></i>
      <div class="cp-col cp-mid">
        <p class="ar-tag ar-tag-acc">Your Space’s server</p>
        <div class="ar-box"><b>The Gate and Needs you</b><span>Every send, post and payment waits here.</span></div>
        <div class="ar-box"><b>Vault</b><span>Logins filled without the model seeing them.</span></div>
        <div class="ar-box"><b>Agents and Flows</b><span>Who asks, and the steps that run with no model.</span></div>
        <div class="ar-box"><b>Pool of screens</b><span>A few screens, shared by every agent’s computer.</span></div>
        <div class="ar-box"><b>Placement</b><span>Decides where work runs from signed descriptions: here, the server, or wait.</span></div>
      </div>
      <i class="cp-arrow" aria-hidden="true"></i>
      <div class="cp-col">
        <p class="ar-tag">Computers that do the work</p>
        <div class="ar-box"><b>Agent computers</b><span>One per agent: desktop, Chrome, terminal.</span></div>
        <div class="ar-box"><b>Your Mac</b><span>Chrome and apps, by the classes you allow.</span></div>
        <div class="ar-box"><b>A computer you lend</b><span>Runs the Space’s sessions in a sandbox.</span></div>
        <div class="ar-box ar-dash">${next()}<b>Any connected device that is awake</b><span>Full Chrome and computer control, on the same grants and the same Gate.</span></div>
        <div class="ar-box ar-dash">${next()}<b>Borrow from the pool</b><span>An agent uses a computer a member has lent, as well as its own.</span></div>
      </div>
    </div>
    <p class="demo-tag">Solid boxes are built. Dashed boxes are coming next.</p>

    <ul class="list rv" style="margin-top:36px">
      <li>${next('0.7')}<b>One Chrome extension</b><span>The password and passkey extension, the Chrome control extension and the standalone server become one. It signs in like a device of yours: its own key, listed in Devices, removable there, with no typed address.</span></li>
      <li>${next('0.7')}<b>Chrome control for chats</b><span>A chat asks to use this Chrome. You allow it once and it is hands-free on that browser until you take it back. Esc or the toolbar stops everything, and sends, posts and payments stay held. No native host and no local port.</span></li>
      <li>${next('0.7')}<b>A chat in the browser side panel</b><span>Every chat there is an ordinary Vyre thread saved in the Space, openable from the app and the phone. The agent sees the current tab only when you turn sharing on.</span></li>
      <li>${next()}<b>Screen Share</b><span>Watch and take over your agents’ computers and Chrome on every device. The take-over rules it needs (keyboard ownership, a shield for private sign-in) are already built in the computers module.</span></li>
      <li>${next()}<b>Drive your computer from your phone</b><span>The phone is already a paired device that approves with Face ID. The direction is a request from it to a connected computer that is awake, under the same grants as an agent’s.</span></li>
      <li>${next()}<b>Agents borrow a computer from the Space’s pool</b><span>Placement already decides where a Space’s sessions run: on a computer lent to it, on the server, or wait. The direction is the same decision for an agent’s computer use.</span></li>
      <li>${next()}<b>A Chrome profile for each agent</b><span>Each agent’s own computer already has its own Chrome profile. The direction is the same inside one person’s Chrome: a tab group and profile per agent, so several agents work there at once.</span></li>
    </ul>
  </div>
</section>

${connects(REPO, SITE, [
  ['/computer/chrome/', 'Vyre for Chrome', 'Install it and see what each way can do.'],
  ['/computer/architecture/', 'Chrome control, architecture', 'The control loop, the hold-and-approve path and the Esc stop.'],
  ['/architecture/', 'Vyre architecture', 'The Gate, the Vault and the layers Vyre Computer plugs into.'],
  [GH(REPO, 'docs/using/computer.md'), 'Vyre Computer, in the docs', 'The tool, the Mac classes and Vault sign-in.'],
  [GH(REPO, 'docs/using/local-runner.md'), 'Lend a computer to a Space', 'The sandbox, the encrypted workspace and the leased key.'],
  [GH(REPO, 'docs/for-agents/MAP-YOUR-BUSINESS.md'), 'Map your business onto Vyre', 'Where computer work fits in a firm’s Flows and agents.'],
])}

<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">Give your agents <b>a computer.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/computer/chrome/">Install Vyre for Chrome</a><a class="btn" href="/start/">Set up Vyre</a></div></div></section>`;
  return {
    slug: 'computer', path: '/computer/',
    title: 'Vyre Computer: agents that work on real computers',
    desc: 'Vyre Computer lets agents work in your Chrome, on your Mac and on computers of their own. Logins come from the Vault and every send waits at the Gate for a person.',
    ogTitle: 'Agents that work on real computers.', ogSub: 'Your Chrome, your Mac and computers of their own, with the Vault and the Gate.',
    body, ld: [crumbs([['Vyre', `${SITE}/`], ['Computer', `${SITE}/computer/`]])],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// /computer/chrome/
// ---------------------------------------------------------------------------------------------------------------------------------------------
function chrome({ SITE, REPO, eyebrow, crumbs, term }) {
  const body = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / <a href="/computer/">Computer</a> / Vyre for Chrome</p>
    ${eyebrow('Vyre for Chrome.')}
    <h1 class="display">Your own Chrome, <b>driven by your agents.</b></h1>
    <p class="lead">Vyre for Chrome works in the Chrome you already have open, signed in as you. It reads a page in one call, fills forms, runs a whole workflow build as a single batch and reads DevTools. A send, a post or a payment is held until you approve it, and Esc stops everything.</p>
    <div class="btn-row"><a class="btn btn-fill" href="#standalone">Install for Claude Code</a><a class="btn" href="#native">Install inside Vyre</a><a class="btn" href="#vault">Vault fill extension</a></div>
  </div>
</section>

<section class="sec" id="does" aria-labelledby="does-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('What it does today.')}
      <h2 id="does-h" class="h2">One extension, <b>a set of tools.</b></h2>
      <p class="lead">The tools are the same in both versions. In Claude Code they are named <code>chrome_snapshot</code>, <code>chrome_act</code> and so on. In Vyre the names carry dots, such as <code>chrome.snapshot</code>.</p>
    </div>
    <div class="cp-cards rv">
      ${card('Read and act', '<code>chrome_snapshot</code> reads the page, its dialogs and every frame in one call. <code>chrome_act</code> and <code>chrome_fill</code> click, type and fill, finding each control by role, name and identifier on a fresh look. <code>chrome_tabs</code> reuses the tab you have open instead of opening one per step.')}
      ${card('Do a whole job in one trip', '<code>chrome_batch</code> runs a list of steps inside the browser with no round trip between them, and stops at the first failure and says which step. <code>chrome_recipe</code> replays a flow that already worked as one call. <code>chrome_ghl</code> builds GoHighLevel workflows end to end, with waits, retries and verified saves.')}
      ${card('Use the site’s own API', '<code>chrome_api</code> learns the page’s own calls and runs them from inside the page with your login. A read tries this first. <code>chrome_op</code> teaches a site an operation once, such as <code>readProfile(slug)</code>, and calls it by name after that.')}
      ${card('Look inside the page', '<code>chrome_inspect</code>, <code>chrome_sources</code>, <code>chrome_console</code> and <code>chrome_net</code> read the DOM, scripts, console and network. <code>chrome_eval</code> runs a script that may read with your login and cannot write with it. <code>chrome_screenshot</code> and <code>chrome_point</code> are the last rung.')}
      ${card('Stay in control', '<code>chrome_plan</code> shows the plan first. <code>chrome_approve</code> asks once for a job with many changes. <code>chrome_send</code> is where you approve a held send. <code>chrome_stop</code> and <code>chrome_resume</code> mirror Esc. <code>chrome_login</code> hands a sign-in page to you.')}
      ${card('Safe by default', 'Passwords, cookies, tokens and session ids are masked before the model sees them. Banks, password managers and sign-in pages are never read or touched. A page with a visible password field never runs a script. Every session writes a masked trace on your computer only.')}
    </div>
  </div>
</section>

<section class="sec" id="standalone" aria-labelledby="standalone-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Way one.')}
      <h2 id="standalone-h" class="h2">Standalone, <b>for Claude Code.</b></h2>
      <p class="lead">An MCP server plus a Chrome extension. No Vyre server is needed. It is the same code that runs inside Vyre. The package and the command are called <code>vyre-chrome</code>.</p>
    </div>
    <div class="cp-need rv"><p class="lbl">You need</p><p>A Mac or a Windows PC, Chrome 116 or newer, Node 22 or newer (nvm and Homebrew installs are fine), and Claude Code. CI also runs it on Linux.</p></div>
    <ol class="steps rv">
      <li><b>Build the package from the repository.</b> One command makes the release folder.${term('git clone --depth 1 https://github.com/vyre-ai/vyre')}${term('node vyre/local/hands-chrome-mac/standalone/build-release.mjs --out ~/vyre-chrome-release')}</li>
      <li><b>Register the connector with Chrome.</b> The launcher finds Node itself, so it works even when your shell has no <code>node</code>. On Windows run <code>vyre-chrome.cmd install</code>.${term('cd ~/vyre-chrome-release/vyre-chrome && ./vyre-chrome install')}Install copies the package to a read-only folder at <code>~/.vyre-chrome/app</code>, puts the <code>vyre-chrome</code> command in <code>~/.local/bin</code>, and prints two things you need next: the extension folder and the exact <code>claude mcp add</code> line for your machine.</li>
      <li><b>Load the extension.</b> Open <code>chrome://extensions</code>, turn on Developer mode, press Load unpacked and choose the folder install printed (<code>~/.vyre-chrome/app/extension</code>). Its id must read <code>jichfmdmnhaphgemkiehddkfcecpncib</code>. The connector only talks to that id. Install waits up to a minute and says “Connected” when the extension answers. If Chrome was already open, it may need one quit and reopen.</li>
      <li><b>Add it to Claude Code, once.</b> Copy the line install printed. It has this shape:${pre('claude mcp add vyre-chrome -- "<node>" "$HOME/.vyre-chrome/app/standalone/cli.mjs" mcp')}</li>
      <li><b>Check it.</b> Start Claude Code and ask it to run <code>chrome_status</code>. It should say connected. <code>vyre-chrome doctor</code> checks the whole path from a terminal and names the one fix.</li>
    </ol>
    <div class="cp-two rv">
      <div class="note"><p class="lbl" style="margin-bottom:8px">Who approves what</p><p style="margin:0">There is no Gate in the standalone version. Claude Code’s own permissions are the approval. Allow the read and act tools if you want it to work without asking. Never put <code>chrome_send</code> or <code>chrome_resume</code> in an allow list: they are where you approve. If your Claude Code can show a question from a tool, the server asks you itself, showing the site, the button and the field values, and a no sends nothing.</p></div>
      <div class="note"><p class="lbl" style="margin-bottom:8px">Settings and removal</p><p style="margin:0"><code>vyre-chrome config learn on|off</code> sets site learning (on by default). <code>vyre-chrome config confirm-sends on|off</code> sets the questions. <code>vyre-chrome logs off</code> stops the trace. <code>vyre-chrome uninstall</code> removes the connector, <code>--purge</code> also deletes the logs. Then remove the extension in <code>chrome://extensions</code>. Browsers: Chrome, Chromium, Brave, Edge, and on a Mac Dia and Arc.</p></div>
    </div>
    <p class="cp-foot rv">The full README, including the GoHighLevel playbook, is in <a href="${GH(REPO, 'local/hands-chrome-mac/standalone/README.md')}">local/hands-chrome-mac/standalone</a>. Chrome shows two bars you cannot hide: a warning about developer-mode extensions at start, and “started debugging this browser” while a tab is being driven.</p>
  </div>
</section>

<section class="sec" id="native" aria-labelledby="native-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Way two.')}
      <h2 id="native-h" class="h2">Native, <b>inside Vyre.</b></h2>
      <p class="lead">The Vyre Computer extension, with the Gate, Needs you and your agents’ grants around it. This is the way to give a named agent your Chrome.</p>
    </div>
    <ol class="steps rv">
      <li><b>Run Vyre on your Mac.</b> The Mac app with a home, or a Mac server. The two Chrome versions do not run side by side: the standalone server refuses to start while Vyre is running, so use one or the other.</li>
      <li><b>Register the connector.</b> Run the Chrome setup once:${term("vyre call chrome.install '{}'")}It registers the connector with each supported browser it finds and prints the steps you do in the browser.</li>
      <li><b>Load the extension.</b> In <code>chrome://extensions</code> turn on Developer mode, press Load unpacked and choose the folder Vyre printed (the extension is <code>local/hands-chrome-mac/extension</code> in the repository). Click its toolbar icon: it says whether it is connected and, if not, why.</li>
      <li><b>Let an agent use it.</b> You hold the grant yourself. A named agent holds one you give it. Before its first action it must post its plan, and a refusal says so: <code>plan_first</code>.</li>
    </ol>
    <div class="cp-two rv">
      <div class="note"><p class="lbl" style="margin-bottom:8px">What native adds</p><p style="margin:0">A held send becomes a card in Needs you, of kind <code>act</code>, with the site, the control and the field values. A panel shows the plan and its steps as they run, and you can interject by typing or voice, retext a step that has not started, or pause. Chrome raises a notification when it needs you. Site learning shows in Memory under Sites, where you can see and forget any of it.</p></div>
      <div class="note"><p class="lbl" style="margin-bottom:8px">The same on both</p><p style="margin:0">The tools, the extension code, the URL floor, the redaction, the script guard, the stop and the trace. Only the approval differs: the Gate in Vyre, <code>chrome_send</code> and Claude Code’s permissions in the standalone version.</p></div>
    </div>
  </div>
</section>

<section class="sec" id="vault" aria-labelledby="vault-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('The sign-in half.')}
      <h2 id="vault-h" class="h2">The Vault fill extension, <b>so no one types a password.</b></h2>
      <p class="lead">Vyre for Chrome never types a password. You do, or this extension does, from your own Vault. It fills logins, cards and addresses and answers passkey requests in Chrome, Arc, Edge and Brave, and fills logins in Firefox. It talks to one address only, your Vyre fill listener, and never sends page content.</p>
    </div>
    <ol class="steps rv">
      <li><b>Turn on the fill listener.</b> Set <code>vault.fill</code> in <code>config.json</code>, for example <code>{ "host": "127.0.0.1", "port": 7788 }</code>, then restart Vyre. On a server, put it behind your own address.</li>
      <li><b>Load the extension.</b> In <code>chrome://extensions</code> (or <code>arc://</code>, <code>edge://</code>, <code>brave://extensions</code>) turn on Developer mode, press Load unpacked and choose <code>modules/vault-extension</code>. For Firefox 121 or later, run <code>node modules/vault-extension/build.mjs</code> and load <code>dist/firefox</code> from <code>about:debugging</code>.</li>
      <li><b>Pair it.</b> Run <code>vyre vault pair</code>. It prints an 8-character code that works once, for 5 minutes. Enter the address and the code in the extension’s popup. <code>vyre vault devices</code> lists paired browsers and revoking one ends it at once.</li>
      <li><b>Use it.</b> Open the popup on a login page, unlock with Touch ID through the Mac app (or a passphrase on a machine without it), and press Fill. One proof opens a fill window of 30 minutes that does not extend with use. Cmd+Shift+L fills the page’s login from the keyboard. Only logins whose hosts include the page’s exact origin are offered.</li>
    </ol>
    <p class="cp-foot rv">It can also offer to save an API key a page shows you once, after you tap Save, and to save a login you just used. Detail is in <a href="${GH(REPO, 'modules/vault-extension/README.md')}">modules/vault-extension</a>.</p>
  </div>
</section>

<section class="sec" id="one" aria-labelledby="one-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${next('0.7')}
      <h2 id="one-h" class="h2">Three pieces become <b>one.</b></h2>
      <p class="lead">Today the password extension, the Chrome control extension and the standalone server are separate. The 0.7 plan merges them into one extension for Chrome first, then Edge, Brave and Arc. It signs in like a device of yours, shows up in Devices and stops working when you remove it there. Chats can then ask to use that Chrome, with Esc and the toolbar as the stop, and a Vyre chat can open in Chrome’s side panel. See <a href="${GH(REPO, 'roadmap/0.7.md')}">the 0.7 plan</a>, items 15 to 19.</p>
    </div>
  </div>
</section>

${connects(REPO, SITE, [
  ['/computer/', 'Vyre Computer', 'The three places an agent can work, and where it is going.'],
  ['/computer/architecture/', 'Chrome control, architecture', 'How it drives a site, remembers it, holds sends and stops on Esc.'],
  [GH(REPO, 'docs/using/connectors.md'), 'Connectors, in the docs', 'Teach a site once and make it a Connection a Flow can call.'],
  [GH(REPO, 'docs/using/vault.md'), 'The Vault, in the docs', 'Logins agents use without seeing them, and autofill in the browser.'],
  ['/architecture/', 'Vyre architecture', 'The Gate and Needs you that hold a send.'],
])}

<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">Read how it <b>works.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/computer/architecture/">The architecture of Chrome control</a><a class="btn" href="/computer/">Back to Vyre Computer</a></div></div></section>`;
  return {
    slug: 'computer/chrome', path: '/computer/chrome/',
    title: 'Vyre for Chrome: install and what it does',
    desc: 'Vyre for Chrome works in your own signed-in Chrome. Install it standalone for Claude Code or native inside Vyre, with step-by-step setup and the Vault fill extension.',
    ogTitle: 'Your own Chrome, driven by your agents.', ogSub: 'Install it standalone for Claude Code or inside Vyre. Sends wait for you.',
    body, ld: [crumbs([['Vyre', `${SITE}/`], ['Computer', `${SITE}/computer/`], ['Vyre for Chrome', `${SITE}/computer/chrome/`]])],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// /computer/architecture/
// ---------------------------------------------------------------------------------------------------------------------------------------------
function architecture({ SITE, REPO, eyebrow, crumbs }) {
  const body = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / <a href="/computer/">Computer</a> / Chrome control, architecture</p>
    ${eyebrow('How Chrome control is built.')}
    <h1 class="display">Driving a site <b>the way the site drives itself.</b></h1>
    <p class="lead">Vyre for Chrome does not click pixels when the site already has a call that does the job. It calls the site’s own API from inside your signed-in page, remembers how each site works, plans before it acts, holds anything that sends, and stops when you press Esc. This page explains each mechanism and names the file that holds it.</p>
  </div>
</section>

<section class="sec" id="stack" aria-labelledby="stack-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('The path of a call.')}
      <h2 id="stack-h" class="h2">One extension, one connector, <b>a module that decides.</b></h2>
      <p class="lead">Decision record: <a href="${GH(REPO, 'docs/adr/0049-deep-chrome-control.md')}">ADR 0049</a>. No debugging port and no browser relaunch. The extension attaches Chrome’s debugger to a tab once and keeps it.</p>
    </div>
    <div class="cp-stack rv" role="group" aria-label="The path of a call, top to bottom: the agent, the Chrome module with its checks, a local socket, the native host, the extension service worker with its capabilities, and the person’s tabs.">
      <div class="ar-box"><b>The agent</b><span>A Claude Code session, or a named agent in Vyre. Calls <code>chrome_snapshot</code>, <code>chrome_api</code>, <code>chrome_act</code> and the rest.</span></div>
      <i class="ar-down" aria-hidden="true"></i>
      <div class="ar-door"><b>The Chrome module</b><span>Decides before anything is sent: the grant, the plan, the stop, the URL floor, redaction of the result. Source: <code>local/hands-chrome-mac/index.js</code> and <code>oversight.js</code>.</span></div>
      <i class="ar-down" aria-hidden="true"></i>
      <div class="ar-box"><b>A local socket, then the native host</b><span>A Unix socket (mode 0600, in a 0700 folder; a named pipe on Windows). Chrome starts the host, which relays framed JSON and reads nothing.</span></div>
      <i class="ar-down" aria-hidden="true"></i>
      <div class="ar-door"><b>The extension’s service worker</b><span>Re-checks the floor, runs the operation in a capability, redacts the result again. Capabilities: tabs, page, devtools, net, api, ghl, batch, ops, recipe, login.</span></div>
      <i class="ar-down" aria-hidden="true"></i>
      <div class="ar-box"><b>Your tabs, through Chrome’s debugger</b><span>One attach per tab, kept until the tab closes or you detach it.</span></div>
    </div>
  </div>
</section>

<section class="sec" id="api" aria-labelledby="api-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Through the site’s own API.')}
      <h2 id="api-h" class="h2">A call is cheaper and surer <b>than a click.</b></h2>
      <p class="lead">A page is a front end for calls to a back end. Vyre Computer watches those calls, learns their shapes and makes the same call itself, from inside the page, so your cookies sign it.</p>
    </div>
    <div class="cp-doc rv">
      <h3>1. Capture</h3>
      <p>The extension keeps a bounded ring buffer of the tab’s network events, from every frame including a cross-origin iframe such as GoHighLevel’s workflow builder. Reading the buffer costs no round trip.</p>
      <h3>2. Learn</h3>
      <p><code>chrome_api learn</code> reduces the buffered XHR and fetch traffic to a catalog: method, path template, query and body shape, the kind of credential (cookie, bearer or a named header), and a sample status. Values are never stored. Each entry records the frame it was learned in.</p>
      <h3>3. Route</h3>
      <p><code>chrome_api route</code> takes a hint such as “contacts” and picks the best matching GET entry. It calls it from inside the page and checks for a 2xx. The reply says which way it went:</p>
      ${pre('{ "route": "api", "entryId": "...", "pathTemplate": "/contacts/{id}", "status": 200, ... }\n{ "route": "ui",  "why": "no learned read matches the hint" }')}
      <p>On <code>"ui"</code> the agent drives the page as before. A tie between two entries, a missing path parameter, a held or refused call and an answer that is not 2xx all return <code>"ui"</code> with the reason. An entry that fails twice is dropped, so a changed app stops being tried.</p>
      <h3>4. Call</h3>
      <p><code>chrome_api call</code> runs one entry inside the page, in the frame it was learned in unless you name another, so that frame’s cookies and auth sign it. For a bearer or header credential, the worker takes the value from the newest captured request and hands it to the page’s own fetch. It is never returned or logged, and the response comes back through the redactor.</p>
      <h3>5. Writes ask</h3>
      <p>A GET passes. A write passes only when the person asked for that call or a plan they approved covers it. A request that sends something as you (a message, a post, a payment, judged by method and endpoint) waits for approval whatever else is true.</p>
    </div>
    <div class="cp-rungs rv">
      <p class="lbl">When the API route does not answer</p>
      <p>Each tool has a rung: API 1, page controls 2, DevTools 3, accessibility tree 4, screenshot and point 5. A failure says which rung it was on and what the next is. When the same target fails twice on rungs 2 to 4 in one chain, the error carries a small fresh screenshot and names <code>chrome_point</code>, so the model does not have to remember the ladder.</p>
    </div>
  </div>
</section>

<section class="sec" id="loop" aria-labelledby="loop-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('The control loop.')}
      <h2 id="loop-h" class="h2">Plan, call, check, <b>remember.</b></h2>
      <p class="lead">Each pass through the loop leaves the next one cheaper. The highlight moves through the stages as the loop runs.</p>
    </div>
    <ol class="ar-flow cp-seq cp-seq5 rv" aria-label="The control loop in five stages">
      ${node('01', 'Agent', 'Asks in words: “list the contacts tagged renewal.” A named agent must hold your grant.')}
      ${node('02', 'Plan', 'Posts its steps first. You see them, can interject, and can stop it.')}
      ${node('03', 'Site API call', 'The best learned read, called from inside your page with your login.')}
      ${node('04', 'Result', 'Checked for a 2xx and redacted. If it fails, the page is driven instead.')}
      ${node('05', 'Memory', 'The endpoint’s confidence moves up or down. What worked is kept for next time.')}
    </ol>
    <div class="cp-return rv" aria-hidden="true"><span>what memory kept starts the next call</span></div>
  </div>
</section>

<section class="sec" id="memory" aria-labelledby="memory-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('It remembers how each site works.')}
      <h2 id="memory-h" class="h2">Structure is kept. <b>A value never is.</b></h2>
      <p class="lead">This is how it does long, complex tasks without relearning a site every time. Memory has three layers, from short-lived to lasting.</p>
    </div>
    <div class="cp-cards rv">
      ${card('Session memory', 'The API catalog and the recipes live in the browser’s session storage and are gone when it closes. A recipe is a flow that worked: <code>chrome_batch</code> with <code>saveAs</code> and every step succeeding. Only its parameters are kept. What you typed never is. <code>chrome_recipe run</code> replays it as one call with no model turn between steps.')}
      ${card('The site record', 'One record per origin: the frame layout, stable controls and how to find them, the site’s API endpoints, how to tell the page is ready or that you must sign in, and the operations you taught. Learning is on by default and one setting turns it off. In Vyre you see and forget a record under Memory, Sites; each forget can be undone for a day. Standalone, a record is a file at <code>~/.vyre-chrome/sites/&lt;hash&gt;.json</code>, mode 0600.')}
      ${card('Taught operations', '<code>chrome_op</code> turns a page’s request into a named, typed call. It runs the trigger twice with two different example inputs, diffs the traffic and drafts the operation. A read is kept only after it answers on an input that was not an example. Credentials are stored as references such as <code>cookie:name</code> and resolved inside the worker. A drift is repaired once and kept only if a replay answers. Each kept version can be rolled back.')}
    </div>
    <ul class="ar-facts rv">
      <li><b>An allowlist, failing closed</b>Only named fields survive, with types and length limits. A string shaped like a credential, a pairing code or a key, or carrying an email, makes the whole patch refused. The refusal names the field and never the text.</li>
      <li><b>Labels need two visits</b>A control’s label is stored only when it was seen on two separate visits, outside a row or list of records, without an email, phone or long number. Otherwise the control is found by identifier or by structure.</li>
      <li><b>Facts heal</b>A stored fact that worked moves its confidence up. One that missed moves it down and is quarantined after repeated misses, so a redesigned page stops being trusted instead of failing silently.</li>
      <li><b>Arrival cards</b>On a revisit the extension has a small card for the origin from memory, never waiting on a server, and the same record format serves Vyre Memory and the standalone files.</li>
    </ul>
  </div>
</section>

<section class="sec" id="long" aria-labelledby="long-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Long and complex tasks.')}
      <h2 id="long-h" class="h2">One round trip for a <b>whole job.</b></h2>
    </div>
    <ul class="ar-facts rv">
      <li><b>Batch inside the browser</b><code>chrome_batch</code> runs its steps in the extension’s worker with no hop to the host between steps. It halts at the first failure, on stop, or on a floor refusal, and says which step.</li>
      <li><b>Waits that match the page</b>Every step waits for spinners, drawers and toasts, and a page counts as settled when there is no spinner, a quiet DOM and a quiet network in every readable frame.</li>
      <li><b>Stale controls retried</b>A control that went stale is looked up again inside a retry budget. Harmless popups (what’s new, tours, cookies) are closed. Anything else, such as unsaved changes or a confirm, stops the run rather than guessing.</li>
      <li><b>Saves verified</b>A save is confirmed by a toast, a disabled Save, a URL change or a list item. One that cannot be confirmed is an error that names the step.</li>
      <li><b>Frames are first class</b>Snapshot, act, fill and wait look in every readable frame, top first. A frame it cannot read is listed with its origin and the reason, and never left out silently.</li>
      <li><b>One approval for many changes</b><code>chrome_approve</code> lists what a job will create, edit or publish. You approve it once. That many creates and edits then go through, and the page shows “step N of M”. A delete, a message to a contact and a payment are never covered. A publish is covered only when your own words asked for it. The plan ends after an hour or when you stop it.</li>
    </ul>
  </div>
</section>

<section class="sec" id="hold" aria-labelledby="hold-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Holds for sends, posts and payments.')}
      <h2 id="hold-h" class="h2">Nothing leaves until <b>you say yes.</b></h2>
      <p class="lead">An agent can ask for a send and cannot approve it. The extension decides what counts as outward from the page itself, not from a label an agent chose.</p>
    </div>
    <ol class="ar-flow ar-flow6 cp-seq cp-seq6 rv" aria-label="The hold-and-approve path in six stages">
      ${node('01', 'Agent acts', 'Presses a control, or makes an API write, that might send.')}
      ${node('02', 'Extension decides', 'A real submit, or a Send, Pay or Post control read from the DOM. For an API write, the method and endpoint.')}
      ${node('03', 'Held', 'Nothing is sent. The agent gets <code>held: true</code>, an id, the field values and a signature of the page.')}
      ${node('04', 'You see it', 'A card in Needs you, or a question from Claude Code, with the site, the button and the fields.')}
      ${node('05', 'You approve', 'Only a person’s yes releases it. The server asks you itself when your client can show a question.')}
      ${node('06', 'Released', 'The page is hashed again. Same signature: it runs. Changed: refused, nothing done.')}
    </ol>
    <div class="cp-hold rv">
      <div class="cp-card" aria-hidden="true"><p class="lbl">Needs you</p><b>kit wants to press Send on app.example.com</b><small>Control: button Send &middot; To: <!--email_off-->sam@example.com<!--/email_off--> &middot; Subject: Your quote</small><div class="cp-btns"><span class="cp-yes">Approve</span><span>Decline</span></div></div>
      <div class="ar-outcomes">
        <div class="ar-out-card ar-allow"><p class="lbl">Approved, page unchanged</p><p>The act runs once, with the page’s own login.</p></div>
        <div class="ar-out-card ar-ask"><p class="lbl">Page changed since the hold</p><p>Refused with code <code>changed</code>. Look again and ask again.</p></div>
        <div class="ar-out-card ar-deny"><p class="lbl">Declined, or no answer</p><p>Nothing is sent. A held act with no answer yet stays held and can be asked again.</p></div>
      </div>
    </div>
    <div class="cp-doc rv">
      <h3>Four layers decide what is held</h3>
      <p><b>The send classifier</b> (<code>extension/shared/outbound.js</code>) judges an API write by method and endpoint: messages, campaigns, invoices and payments, social posts, and any write to an endpoint whose name says it sends, posts or pays. GraphQL and RPC bodies are read for the action.</p>
      <p><b>The write gate</b> holds every other change made with your login (a create, an edit, a delete) unless you asked for that call or a plan you approved covers it. The request function refuses a write that did not pass through it.</p>
      <p><b>The page act</b> holds an outward control chosen from the DOM. The held result carries the form’s non-secret values and a signature of the page. The release re-hashes the page and refuses with <code>changed</code> on any difference.</p>
      <p><b>The script guard</b> wraps a script an agent runs with <code>chrome_eval</code>. It may read with your login and cannot write. A send it tries is held, and it cannot reach a site the page does not already talk to. The browser enforces that for HTTP and HTTPS requests, navigation, WebSockets and beacons, in every frame of the tab, and CI proves it in a real Chrome.</p>
    </div>
  </div>
</section>

<section class="sec" id="stop" aria-labelledby="stop-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Esc stops everything.')}
      <h2 id="stop-h" class="h2">You press it. <b>Only you undo it.</b></h2>
      <p class="lead">While an agent works in a tab, a dark pill in that tab says “Step 12 of 20”, the step in plain words, and “Esc to stop”.</p>
    </div>
    <div class="cp-pillwrap rv" aria-hidden="true"><div class="cp-pill"><span class="cp-p1"><i class="cp-live"></i>Step 3 of 8 &middot; Filling 4 fields &middot; Esc to stop</span><span class="cp-p2"><i class="cp-halt"></i>You pressed Esc. Continue from Vyre or the toolbar icon.</span></div></div>
    <ul class="ar-facts rv">
      <li><b>Four ways in</b>Esc in the tab, the Stop button on the pill, the shortcut Cmd+Shift+E (Ctrl+Shift+E elsewhere), and the toolbar icon. A person’s stop and an agent’s <code>chrome_stop</code> are the same state.</li>
      <li><b>Set before anything is awaited</b>The stopped flag is set first, so the very next call is refused with code <code>stopped</code>. The extension is told in the same breath, so a running batch halts within a step. Each stop’s latency is recorded.</li>
      <li><b>It waits for you</b>Nothing continues until the person answers and <code>chrome_resume</code> is called. A model cannot lift your stop. In the standalone version the server asks you itself before it carries on, and if the client cannot ask, the resume is refused.</li>
      <li><b>Pause and interject</b>You can pause from the panel, which holds exactly like Esc, or tell the agent something by typing or voice. It reaches the agent on its very next call, once, so it can change course.</li>
    </ul>
  </div>
</section>

<section class="sec" id="floor" aria-labelledby="floor-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('The floor, redaction and logs.')}
      <h2 id="floor-h" class="h2">Some pages are off limits. <b>Everything is written down.</b></h2>
    </div>
    <div class="cp-cards rv">
      ${card('The URL floor', 'One list, checked by the module before anything is sent and again in the worker. <b>Blind</b> pages return nothing and refuse every operation: banks, password-manager web vaults, sign-in pages, Vyre’s own surfaces, the browser’s own pages and the Web Store. <b>Hands</b>-only pages are readable and not actable. A hostname that says “bank” is caught too, and you can add your own entries.')}
      ${card('Redaction', 'Cookies, tokens, session ids, CSRF tokens, API keys and passwords are removed before the model sees them. Names and lengths stay, values never. It runs in the extension on every result and again in the module. There is no argument that asks for a raw value. A page with a visible password field never runs a script, in any frame.')}
      ${card('Logs', 'Every session writes one trace file on your computer only. Each call records its masked arguments, queue, run and page time, success, the failing step, retries, which selector strategy matched, the page’s host and path without the query, the rung used, and a small masked snippet of the page on failure. Typed values are logged as their length, except on GoHighLevel builder pages. Old logs are removed to stay under 100 MB. <code>vyre-chrome report</code> bundles the last sessions, masked.')}
    </div>
    <p class="cp-foot rv">Tests: the Chrome control suite runs against a fake extension on every change, and a real-Chrome job installs the connector with its own <code>install</code> command, starts the server and drives it like Claude Code on macOS, Windows and Linux.</p>
  </div>
</section>

${connects(REPO, SITE, [
  ['/computer/', 'Vyre Computer', 'Chrome control is one of three places an agent can work.'],
  ['/computer/chrome/', 'Install Vyre for Chrome', 'The two ways to run this, step by step.'],
  ['/architecture/', 'Vyre architecture', 'The Gate and Needs you that hold a send, and the Vault.'],
  [GH(REPO, 'docs/adr/0049-deep-chrome-control.md'), 'ADR 0049: Deep Chrome control', 'The decision record with the frame model and the speed design.'],
  [GH(REPO, 'local/hands-chrome-mac/standalone/GHL-PLAYBOOK.md'), 'GoHighLevel playbook', 'How the flows, waits and verified saves apply to one real product.'],
])}

<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">Try it on <b>your own Chrome.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/computer/chrome/">Install Vyre for Chrome</a><a class="btn" href="/computer/">Back to Vyre Computer</a></div></div></section>`;
  return {
    slug: 'computer/architecture', path: '/computer/architecture/',
    title: 'Chrome control architecture: API-first, plans, holds, Esc',
    desc: 'How Vyre for Chrome works: it calls a site’s own API from inside your page, remembers each site, plans first, holds sends for approval, stops on Esc and logs locally.',
    ogTitle: 'Driving a site the way the site drives itself.', ogSub: 'API first, site memory, plans, held sends, Esc to stop, local logs.',
    body, ld: [crumbs([['Vyre', `${SITE}/`], ['Computer', `${SITE}/computer/`], ['Chrome control, architecture', `${SITE}/computer/architecture/`]])],
  };
}

export function computerPages(h) { return [overview(h), chrome(h), architecture(h)]; }
