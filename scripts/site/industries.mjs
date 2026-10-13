// vyre.run/for/: one page per kind of professional services firm, plus an index. Called from scripts/gen-site.mjs with its helpers.
// The copy is data in ./industries-data.mjs. This file is the page shape, so every industry page reads the same way.
// Styles are the in-* block at the end of site/v2.css.

import { INDUSTRIES } from './industries-data.mjs';

const MAP_DOC = 'https://vyre.run/docs/for-agents/MAP-YOUR-BUSINESS.md';
const FEAT = 'https://vyre.run/docs/architecture/features';

const TAG_HREF = {
  Flows: `${FEAT}/flows`, Records: `${FEAT}/records`, Agents: `${FEAT}/agents`, 'Needs you': `${FEAT}/tasks-and-needs-you`,
  Gate: `${FEAT}/gate`, Documents: `${FEAT}/documents-and-signing`, Signing: `${FEAT}/documents-and-signing`,
  Playbooks: `${FEAT}/tasks-and-needs-you`, Connections: 'https://vyre.run/docs/using/connectors', Vault: `${FEAT}/vault`,
};

export function buildIndustries(h) {
  const { page, esc, eyebrow, crumbs, SITE, VERSION } = h;
  const home = `${SITE}/`;

  const promptFor = (d) => `Read ${SITE}/llms-full.txt and ${MAP_DOC}. I run ${d.name}. We use ${d.stack.map((s) => s[0]).slice(0, 5).join(', ')}. Interview me about my people, what we track, the kinds of work we do, our paperwork and our software. Then show my business as a Vyre Space: members and roles, record types, a Playbook for each kind of work, Flows, agents with roles, documents and signing, a client page, the apps to connect, and what waits for my yes. Mark what Vyre does today and what is Next. Design on paper and change nothing until I say so.`;

  const promptBlock = (text, id = 'prompt') => `
<div class="in-prompt rv" id="${id}">
  <div class="in-prompt-h"><span class="lbl">Copy this into Claude, Codex or any agent</span><button type="button" data-copy="${esc(text)}" aria-label="Copy the prompt">Copy</button></div>
  <p class="in-prompt-t">${esc(text)}</p>
</div>`;

  const connectsTo = (items) => `
<section class="sec" aria-labelledby="connects-h">
  <div class="wrap">
    <h2 id="connects-h" class="lbl" style="margin-bottom:20px">Connects to</h2>
    <ul class="in-conn rv">${items.map(([t, u, s]) => `<li><a href="${u}"><b>${t}</b><span>${s}</span></a></li>`).join('')}</ul>
  </div>
</section>`;

  const tags = (arr) => `<span class="in-tags">${arr.map((t) => (TAG_HREF[t] ? `<a href="${TAG_HREF[t]}">${t}</a>` : `<i>${t}</i>`)).join('')}</span>`;
  const isAgent = (doer) => /agent/i.test(doer);

  // ----- one industry page -----
  function industryPage(d) {
    const others = INDUSTRIES.filter((x) => x.slug !== d.slug);
    const body = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / <a href="/for/">For</a> / ${d.short}</p>
    ${eyebrow(`For ${d.short.toLowerCase()}.`)}
    <h1 class="display">${d.h1}</h1>
    <p class="lead">${d.lead}</p>
    <div class="btn-row"><a class="btn btn-fill" href="#prompt">Map my business</a><a class="btn" href="#journey">Follow the journey</a></div>
  </div>
</section>

<section class="sec" id="journey" aria-labelledby="journey-h" style="padding-top:64px">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('The client journey.')}
      <h2 id="journey-h" class="h2">Eight steps, <b>one record that carries them.</b></h2>
      <p class="lead">${esc(d.firm)} follows one client through the whole firm. Each step names the Vyre pieces behind it. Where a step sends something out, a person approves the exact words first.</p>
    </div>
    <ol class="in-jn rv" aria-label="The client journey at ${esc(d.firm)}">
      ${d.journey.map(([t, b, tg], i) => `<li class="in-jn-node" style="--i:${i}"><span class="in-n">${String(i + 1).padStart(2, '0')}</span><b>${t}</b><p>${b}</p>${tags(tg)}</li>`).join('')}
    </ol>
    <p class="sm" style="margin-top:18px">${esc(d.firm)} is invented. Names, dates and amounts on this page are sample data.</p>
  </div>
</section>

<section class="sec" id="records" aria-labelledby="records-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Records.')}
      <h2 id="records-h" class="h2">The things ${esc(d.firm)} tracks, <b>as records you shape.</b></h2>
      <p class="lead">Each type has fields in named groups, links to other types, views and sealed values. ${d.recordsNote}</p>
    </div>
    <div class="in-grid4 rv">
      ${d.records.map((r) => `
      <article class="in-rc">
        <header><b>${r.name}</b><span class="pill">${r.src}</span></header>
        <ul>${r.fields.map(([n, k]) => `<li><span>${n}</span>${k === 'sealed' ? '<i class="in-sealed">sealed <em aria-hidden="true">&bull;&bull;&bull;&bull;&bull;&bull;</em></i>' : `<i>${k}</i>`}</li>`).join('')}</ul>
        <p>${r.links}</p>
      </article>`).join('')}
    </div>
  </div>
</section>

<section class="sec" id="playbooks" aria-labelledby="pb-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Playbooks.')}
      <h2 id="pb-h" class="h2">Each kind of work is <b>its own track.</b></h2>
      <p class="lead">A Playbook lists stages, the tasks in each stage and who does each task: a person, a role or an agent. A Flow reads the field that names the track and starts the matching Playbook. The tracks run side by side over the same records.</p>
    </div>
    <div class="in-pbs rv">
      ${d.playbooks.map((p) => `
      <article class="in-pb">
        <header><b>${p.name}</b><span class="lbl">${p.stages.length} stages</span></header>
        <div class="in-bar" aria-hidden="true"><i></i></div>
        <ol class="in-st">${p.stages.map(([s, ts]) => `<li><b>${s}</b>${ts.map(([t, who]) => `<span>${t}<em class="${isAgent(who) ? 'ag' : ''}">${who}</em></span>`).join('')}</li>`).join('')}</ol>
      </article>`).join('')}
    </div>
  </div>
</section>

<section class="sec" id="flows" aria-labelledby="flows-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Flows.')}
      <h2 id="flows-h" class="h2">Work that runs <b>the same way every time.</b></h2>
      <p class="lead">A Flow is written once and approved by a person. A trigger starts it, steps do the work, and it stops wherever a person has to say yes. Each run has its own page with a step timeline. In the chains below, <span class="in-key t">outlined</span> is the trigger, <span class="in-key a">tinted</span> is an agent, <span class="in-key q">dashed</span> waits for a person and <span class="in-key g">dark</span> is held at the Gate.</p>
    </div>
    <div class="in-flows rv">
      ${d.flows.map((f) => `
      <article class="in-flow">
        <p class="lbl">${f.name}</p>
        <div class="in-chips">${f.chips.map(([k, t], i) => `<span class="in-chip ${k}" style="--i:${i}">${t}</span>`).join('')}</div>
        <p class="sm">${f.note}</p>
      </article>`).join('')}
    </div>
  </div>
</section>

<section class="sec" id="agents" aria-labelledby="agents-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Agents with roles.')}
      <h2 id="agents-h" class="h2">The drafting is done. <b>The decisions are yours.</b></h2>
      <p class="lead">An agent has a job in one sentence, an AGENTS.md that says how to do it and a list of projects it works in. Anyone in the Space can share it with a person or a role as use-only or full. A reviewer is an agent whose instructions say what to check, with a standing duty on an event. It marks a task stuck with a plain reason when it cannot decide, and that task waits under Needs you.</p>
    </div>
    <div class="in-grid4 rv">
      ${d.agents.map(([mk, n, job, where, who, cant]) => `
      <article class="in-ag">
        <header><span class="mk vi" aria-hidden="true">${mk}</span><b>${n}</b></header>
        <p>${job}</p>
        <dl><dt>Works in</dt><dd>${where}</dd><dt>May use it</dt><dd>${who}</dd><dt>Does not</dt><dd>${cant}</dd></dl>
      </article>`).join('')}
    </div>

    <div class="feat" style="margin-top:clamp(48px,7vw,88px)">
      <div class="feat-copy rv">
        <span class="num">NEEDS YOU</span>
        <h3 class="h2" style="font-size:clamp(26px,3.4vw,40px)">One place for <b>everything that waits.</b></h3>
        <p class="lead">Approvals, questions and stuck tasks land in one list, on the Mac, the web app and the phone. An agent can ask and cannot approve. The person sees the exact words, approves or edits, and only then does the email, the signature request or the page go out.</p>
      </div>
      <div class="mock rv">
        <div class="win" role="img" aria-label="Sample Needs you list with three items waiting for a person">
          <div class="win-bar"><i></i><i></i><i></i><span class="t">Needs you &middot; sample data</span></div>
          <div class="rows">
            ${d.needs.map(([k, t, acts], i) => `<div class="row"><span class="in-wait${i === 0 ? ' on' : ''}" aria-hidden="true"></span><div class="grow"><small>${k}</small>${t}</div>${acts.map((a, j) => `<span class="pill${j === 0 ? ' go' : ''}">${a}</span>`).join('')}</div>`).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="sec" id="paper" aria-labelledby="paper-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Paperwork, secrets and pages.')}
      <h2 id="paper-h" class="h2">Your own documents, <b>your own logins, your own page.</b></h2>
    </div>
    <div class="ar-ideas rv">
      ${d.trio.map(([t, b], i) => `<div class="piece"><span class="num">0${i + 1}</span><h3>${t}</h3><p>${b}</p></div>`).join('')}
    </div>
  </div>
</section>

<section class="sec" id="stack" aria-labelledby="stack-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Connect your stack.')}
      <h2 id="stack-h" class="h2">Vyre can be extended by integrating your Zoho, QuickBooks, RingCentral <b>and the rest of your software stack*</b></h2>
      <p class="lead">${esc(d.firm)} keeps its tools. Vyre reaches them through the same checks as everything else: the key lives in the Vault, every call is marked read, draft, change, send, spend or delete, and anything that leaves the Space waits at the Gate.</p>
    </div>
    <ul class="in-stack rv">
      ${d.stack.map(([n, s, t]) => `<li><b>${n}</b><span class="pill${s === 'Today' ? ' ok' : s === 'Connection' ? ' acc' : ''}">${s}</span><span>${t}</span></li>`).join('')}
    </ul>
    <p class="sm" style="margin-top:14px">*where the vendor provides an API</p>

    <div class="ar-where rv" style="margin-top:36px">
      <div class="note"><p class="lbl" style="margin-bottom:8px">Today</p>
        <p><b>A Connection plus a Flow step.</b> A person adds a Connection: a declared host, how the key is sent and a list of operations, each marked by what it does. A Flow’s service step calls an operation, and a send waits at the Gate.</p>
        <p style="margin:0"><b>Or a custom module.</b> A module is a folder with a <code>module.json</code> and an entry file. It registers tools, emits events and declares Flow steps under the same checks as the built-in modules. An agent can write one on your own server.</p></div>
      <div class="note"><p class="lbl" style="margin-bottom:8px">Next, 0.5.2</p>
        <p><b>Integrations, packaged.</b> An Integration wraps an application’s API and ships its own Flow steps, triggers, Connection and agent tools. You install, verify, configure and remove it from one place. An agent can make one from an API.</p>
        <p style="margin:0">Clio, Lawmatics, GoHighLevel and DecisionVault are the first planned. This is direction, not a date.</p></div>
    </div>
  </div>
</section>

<section class="sec" id="map" aria-labelledby="map-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Your turn.')}
      <h2 id="map-h" class="h2">Ask your agent to <b>map your business.</b></h2>
      <p class="lead">Paste this into Claude, Codex or any agent that can read the web. It interviews you, then draws your firm as a Vyre Space on paper. Nothing changes until you say so. The full prompt lives on <a href="/">the home page</a>.</p>
    </div>
    ${promptBlock(promptFor(d))}
    <div class="btn-row"><a class="btn btn-fill" href="/map/">Explore the interactive map</a><a class="btn" href="${MAP_DOC}">Read the method</a></div>
  </div>
</section>
${connectsTo([
  ['Architecture', '/architecture/', 'The layers, how a call is checked and how the Gate holds an outward act.'],
  ['Flows', `${FEAT}/flows`, 'Triggers, steps, waits, failure paths and how a run is replayed.'],
  ['Records and Playbooks', `${FEAT}/records`, 'Types, fields, stage sets, sealed values and views.'],
  ['Documents and signing', `${FEAT}/documents-and-signing`, 'Fill your Word templates from a record and send them for signature.'],
  ['The Gate', `${FEAT}/gate`, 'Why nothing leaves the Space until a person approves the exact words.'],
  ['Direction', '/direction/', 'What comes next, including Integrations in 0.5.2.'],
  ...others.slice(0, 2).map((o) => [`For ${o.short.toLowerCase()}`, `/for/${o.slug}/`, 'The same journey for another kind of firm.']),
])}
`;
    page({
      slug: `for-${d.slug}`, path: `/for/${d.slug}/`, title: d.title, desc: d.desc,
      ogTitle: `Vyre for ${d.short.toLowerCase()}.`, ogSub: d.ogSub, body,
      ld: [crumbs([['Vyre', home], ['For', `${SITE}/for/`], [d.short, `${SITE}/for/${d.slug}/`]])],
    });
  }

  // ----- the index -----
  function indexPage() {
    const body = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / For</p>
    ${eyebrow('Vyre for your kind of firm.')}
    <h1 class="display">Your firm, as an <b>AI-native firm.</b></h1>
    <p class="lead">Our mission is to help every professional services team become AI-native. Pick the kind of firm closest to yours. Each page follows one client from the first inquiry to closed work and shows the records, Playbooks, Flows and agents behind every step.</p>
    <div class="btn-row"><a class="btn btn-fill" href="/map/">Explore the interactive map</a><a class="btn" href="#prompt">Map my business</a></div>
  </div>
</section>

<section class="sec" style="padding-top:56px" aria-labelledby="kinds-h">
  <div class="wrap">
    <h2 id="kinds-h" class="lbl" style="margin-bottom:20px">Five journeys</h2>
    <div class="in-kinds rv">
      ${INDUSTRIES.map((d, i) => `
      <a class="in-kind" href="/for/${d.slug}/">
        <span class="num">0${i + 1}</span>
        <b>${d.short}</b>
        <span>${d.summary}</span>
        <span class="go">Follow the journey</span>
      </a>`).join('')}
    </div>
  </div>
</section>

<section class="sec" aria-labelledby="same-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('What every journey shares.')}
      <h2 id="same-h" class="h2">One product, <b>shaped to the firm.</b></h2>
      <p class="lead">The pages differ in their words. The pieces underneath are the same, and you shape them without writing code.</p>
    </div>
    <div class="in-grid3 rv">
      <div class="piece"><span class="num">01</span><h3>Records you shape</h3><p>As many types as the firm has, joined by links, with views and sealed fields an agent never reads.</p></div>
      <div class="piece"><span class="num">02</span><h3>A Playbook per track</h3><p>Each kind of work has its own stages, tasks and doers, and they run side by side over shared records.</p></div>
      <div class="piece"><span class="num">03</span><h3>Flows with a person in the loop</h3><p>Triggers, waits and branches run the same way each time. A send, a signature request or a page waits for a yes.</p></div>
      <div class="piece"><span class="num">04</span><h3>Agents with roles</h3><p>Intake, drafting, reviewer and more, in one group chat across Claude, Codex, Grok and OpenRouter.</p></div>
      <div class="piece"><span class="num">05</span><h3>Your documents and signing</h3><p>Your Word templates, filled from records. Signers need no account, and the signed copy files on the record.</p></div>
      <div class="piece"><span class="num">06</span><h3>Your stack, connected</h3><p>Vyre can be extended by integrating your Zoho, QuickBooks, RingCentral and the rest of your software stack*</p></div>
    </div>
    <p class="sm" style="margin-top:14px">*where the vendor provides an API. Today a Connection plus a Flow step, or a custom module. Next, 0.5.2: packaged Integrations.</p>
  </div>
</section>

<section class="sec" id="map" aria-labelledby="map-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Not on the list?')}
      <h2 id="map-h" class="h2">Ask your agent to <b>map your business.</b></h2>
      <p class="lead">Insurance agencies, architecture and engineering firms and others follow the same method. Paste this into Claude, Codex or any agent that can read the web. The full prompt lives on <a href="/">the home page</a>.</p>
    </div>
    ${promptBlock(`Read ${SITE}/llms-full.txt and ${MAP_DOC}. I run [describe your firm]. We use [your main software]. Interview me about my people, what we track, the kinds of work we do, our paperwork and our software. Then show my business as a Vyre Space: members and roles, record types, a Playbook for each kind of work, Flows, agents with roles, documents and signing, a client page, the apps to connect, and what waits for my yes. Mark what Vyre does today and what is Next. Design on paper and change nothing until I say so.`)}
    <div class="btn-row"><a class="btn btn-fill" href="/map/">Explore the interactive map</a><a class="btn" href="${MAP_DOC}">Read the method</a></div>
  </div>
</section>
${connectsTo([
  ['Architecture', '/architecture/', 'The layers, how a call is checked and how the Gate holds an outward act.'],
  ['Direction', '/direction/', 'What is built, what is Next and in which version.'],
  ['Get started', '/start/', 'Install Vyre and pair your server.'],
])}
`;
    page({
      slug: 'for', path: '/for/', title: 'Vyre for professional services firms: law, accounting, consulting, agencies, real estate',
      desc: 'Pick the kind of firm closest to yours and follow one client from the first inquiry to closed work on Vyre: records, Playbooks, Flows, agents with roles and your own stack.',
      ogTitle: 'Your firm, as an AI-native firm.', ogSub: 'Law, accounting, consulting, agencies and real estate: one client journey each.', body,
      ld: [crumbs([['Vyre', home], ['For', `${SITE}/for/`]])],
    });
  }

  indexPage();
  INDUSTRIES.forEach(industryPage);

  // ----- machine-readable text -----
  const llms = [
    `- [For professional services firms](${SITE}/for/): client journeys on Vyre by kind of firm`,
    ...INDUSTRIES.map((d) => `- [Vyre for ${d.short.toLowerCase()}](${SITE}/for/${d.slug}/): ${d.summary}`),
  ].join('\n');
  const full = [
    '## Vyre by kind of firm (pages under ' + SITE + '/for/)',
    'Each page follows one client from inquiry to closed work for an invented firm, and names the Vyre pieces behind every step. The firms and the sample data are invented.',
    ...INDUSTRIES.map((d) => `### ${d.short}: ${SITE}/for/${d.slug}/\n${d.journey.map(([t], i) => `${i + 1}. ${t}`).join('\n')}\nTracks (Playbooks): ${d.playbooks.map((p) => p.name).join(', ')}. Agents: ${d.agents.map((a) => a[1]).join(', ')}. Apps named: ${d.stack.map((s) => s[0]).join(', ')}.`),
    'Connecting a stack: Vyre can be extended by integrating your Zoho, QuickBooks, RingCentral and the rest of your software stack*. *where the vendor provides an API. Today: a Connection plus a Flow service step, or a custom module. Next, 0.5.2: packaged Integrations (Clio, Lawmatics, GoHighLevel and DecisionVault are the first planned).',
  ].join('\n\n');
  const sitemap = [['/for/', '0.7'], ...INDUSTRIES.map((d) => [`/for/${d.slug}/`, '0.7'])];
  return { llms, full, sitemap };
}
