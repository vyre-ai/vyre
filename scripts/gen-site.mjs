#!/usr/bin/env node
// gen-site.mjs: writes the vyre.run pages from one place, so the nav, footer, metadata and structured data
// never drift apart.
//
//   node scripts/gen-site.mjs            writes site/index.html, site/{mac,windows,linux,phone,direction}/index.html,
//                                        site/sitemap.xml, site/robots.txt, site/llms.txt, site/llms-full.txt,
//                                        site/agents.md and site/.well-known/agent.json
//   node scripts/gen-site.mjs --og DIR   also writes DIR/<slug>.html, one 1200x630 card per page, for scripts/gen-og.sh
//
// It never writes the served installers (install.sh, i, w, box/*) or the setup page (setup/*), and it leaves /start alone.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '..', 'site');
const SITE = 'https://vyre.run';
// The release the site speaks for. scripts/assemble-site.sh --tag vX.Y.Z passes it as VYRE_SITE_VERSION, so a release updates every page by itself;
// the default is the newest release this file knows the notes for (RELEASE_NOTES below).
const VERSION = process.env.VYRE_SITE_VERSION && /^\d+\.\d+\.\d+$/.test(process.env.VYRE_SITE_VERSION) ? process.env.VYRE_SITE_VERSION : '0.2.9';
// What each release fixed, in the words the home page and llms-full.txt use. A version with no entry here shows no "out now" line.
const RELEASE_NOTES = {
  '0.2.1': 'Claude sign-in accepts the pasted code, and the phone app installs properly from the home screen.',
  '0.2.9': 'the first release of the 0.3 work: Spaces, Wink, the objects layer and the one-yes approvals.',
  '0.2.2': 'Your own phone, Deck and Mac stop locking each other out of a conversation, a session on a server always gets Vyre\u2019s tools, a provider\u2019s only account is its default, and a message you send shows Sending until the server answers.',
};
const RELEASE_LINE = RELEASE_NOTES[VERSION] ? `${VERSION} (out now): ${RELEASE_NOTES[VERSION]}` : '';
const MODIFIED = new Date().toISOString().slice(0, 10);
// A hash of each asset goes in its URL, so a deploy never meets a stale copy in a browser cache (see site/_headers).
const hash = (f) => createHash('sha256').update(readFileSync(join(site, f))).digest('hex').slice(0, 10);
const CSS_V = `/v2.css?v=${hash('v2.css')}`, JS_V = `/v2.js?v=${hash('v2.js')}`;
const FONTS = 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';
const ogDir = process.argv.includes('--og') ? resolve(process.argv[process.argv.indexOf('--og') + 1]) : null;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- shared marks and icons ----------
const MARK = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 5.5L12 19.5L17.96 9.69" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20.5" cy="5.5" r="2.3" fill="currentColor"/></svg>`;
const WORD = `<svg width="52" height="22" viewBox="-2 3 62 26" fill="none" aria-hidden="true"><path d="M0 6L6 20L12 6M16 6L22 20M28 6L19.4 26M33 6V20M33 13Q33 6 40 6M43 13H57A7 7 0 1 0 55.36 17.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ic = (d, w = 28) => `<svg class="ic" width="${w}" height="${w}" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  mac: ic('<rect x="3.5" y="5" width="21" height="14" rx="2"/><path d="M10 23h8M14 19v4"/>'),
  win: ic('<path d="M4 6.5l8.5-1.2v8.2H4zM14 5l10-1.4v9.9H14zM4 15h8.5v8.2L4 22zM14 15h10v9.4L14 23z"/>'),
  server: ic('<rect x="4" y="5" width="20" height="7" rx="1.6"/><rect x="4" y="16" width="20" height="7" rx="1.6"/><path d="M8 8.5h.01M8 19.5h.01M13 8.5h8M13 19.5h8"/>'),
  phone: ic('<rect x="8" y="3.5" width="12" height="21" rx="2.6"/><path d="M12.5 21h3"/>'),
  ai: ic('<circle cx="14" cy="14" r="9.5"/><path d="M14 8v6l4 2.4"/>'),
  agents: ic('<circle cx="9" cy="10" r="3.2"/><circle cx="19" cy="10" r="3.2"/><path d="M3.5 22c.6-3.6 2.8-5.4 5.5-5.4s4.9 1.8 5.5 5.4M13.5 22c.6-3.6 2.8-5.4 5.5-5.4s4.9 1.8 5.5 5.4"/>'),
  modules: ic('<rect x="4" y="12" width="9" height="9" rx="1.4"/><rect x="15" y="12" width="9" height="9" rx="1.4"/><rect x="9.5" y="4" width="9" height="9" rx="1.4"/><path d="M12 4v-.01M17 4v-.01"/>'),
  people: ic('<circle cx="14" cy="9.5" r="4"/><path d="M5.5 23c.8-4.6 4-7 8.5-7s7.7 2.4 8.5 7"/>'),
};
const STAR = `<svg class="star-ic" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>`;
const REPO = 'https://github.com/vyre-ai/vyre';

// ---------- layout ----------
const NAV = [
  ['Product', '/#product'],
  ['Devices', '/#devices'],
  ['Direction', '/direction/'],
  ['Open source', '/#open'],
];
function nav(slug) {
  const links = NAV.map(([t, h]) => {
    const cur = (slug === 'direction' && h === '/direction/') ? ' aria-current="page"' : '';
    return `<a href="${h}"${cur}>${t}</a>`;
  }).join('');
  return `<a class="skip" href="#main">Skip to content</a>
<header class="nav">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Vyre, home">${MARK}${WORD}</a>
    <nav class="nav-links" id="links" aria-label="Main">${links}</nav>
    <div class="nav-end">
      <a class="star-pill" href="${REPO}" aria-label="Star Vyre on GitHub">${STAR}<span>Star</span></a>
      <button class="icon-btn" id="theme" type="button" aria-label="Switch theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor"/></svg></button>
      <a class="btn btn-fill btn-sm" href="/start/">Set up Vyre</a>
      <button class="icon-btn menu-btn" id="menu" type="button" aria-expanded="false" aria-controls="links" aria-label="Menu"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 5h12M2 11h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    </div>
  </div>
</header>`;
}
const FOOT = `<footer class="foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <a class="brand" href="/" aria-label="Vyre, home">${MARK}${WORD}</a>
        <p class="tag">Your AI command center, on your own machines. Open source, Apache 2.0.</p>
      </div>
      <div><p class="fh">Devices</p><ul><li><a href="/mac/">Mac</a></li><li><a href="/windows/">Windows</a></li><li><a href="/linux/">Linux server</a></li><li><a href="/phone/">Phone</a></li></ul></div>
      <div><p class="fh">Learn</p><ul><li><a href="/direction/">Direction</a></li><li><a href="/start/">Get started</a></li><li><a href="/privacy/">Privacy</a></li><li><a href="https://github.com/vyre-ai/vyre/blob/main/docs/known-gaps.md">Known gaps</a></li></ul></div>
      <div><p class="fh">Open source</p><ul><li><a href="https://github.com/vyre-ai/vyre">GitHub</a></li><li><a class="star-link" href="https://github.com/vyre-ai/vyre">${STAR}Star on GitHub</a></li><li><a href="https://github.com/vyre-ai/vyre/releases">Releases</a></li><li><a href="https://github.com/vyre-ai/vyre/blob/main/LICENSE">License</a></li><li><a href="https://github.com/vyre-ai/vyre#readme">Docs</a></li></ul></div>
      <div><p class="fh">For machines</p><ul><li><a href="/llms.txt">llms.txt</a></li><li><a href="/llms-full.txt">llms-full.txt</a></li><li><a href="/agents.md">agents.md</a></li><li><a href="/sitemap.xml">Sitemap</a></li></ul></div>
    </div>
    <div class="foot-base"><span>Vyre ${VERSION} &middot; Apache 2.0</span><span>No trackers. No cookies. One stylesheet, one script.</span></div>
  </div>
</footer>`;

const ORG = { '@type': 'Organization', '@id': `${SITE}/#org`, name: 'Vyre', url: `${SITE}/`, logo: `${SITE}/icon-512.png`, sameAs: ['https://github.com/vyre-ai'] };
const SOFT = (extra = {}) => ({
  '@type': 'SoftwareApplication', '@id': `${SITE}/#app`, name: 'Vyre', url: `${SITE}/`,
  description: 'Open-source command center for AI agents that runs on your own machines. One session across Claude, Codex, Grok and OpenRouter, with memory, a vault, teammates and watchers. Reach it from a Mac, a Windows PC, a Linux server or any phone.',
  applicationCategory: 'DeveloperApplication', operatingSystem: 'macOS, Windows, Linux, iOS, Android', softwareVersion: VERSION,
  license: 'https://www.apache.org/licenses/LICENSE-2.0', isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, publisher: { '@id': `${SITE}/#org` },
  codeRepository: 'https://github.com/vyre-ai/vyre', downloadUrl: `${SITE}/start/`, ...extra,
});
const crumbs = (items) => ({ '@type': 'BreadcrumbList', itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url })) });
const faqLd = (faq) => ({ '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: strip(a) } })) });

function page({ slug, path, title, desc, body, ld = [], ogTitle, ogSub, type = 'website' }) {
  const url = SITE + path;
  const og = `${SITE}/og/${slug || 'home'}.png`;
  const graph = { '@context': 'https://schema.org', '@graph': [ORG, ...ld] };
  const html = `<!doctype html>
<!-- You read source. Vyre is open source: github.com/vyre-ai/vyre. No framework, no trackers: static pages, one stylesheet, one small script. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${url}">
  <meta name="theme-color" content="#F4F1EA" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0E0D0C" media="(prefers-color-scheme: dark)">
  <meta name="color-scheme" content="light dark">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
  <meta property="og:type" content="${type}">
  <meta property="og:site_name" content="Vyre">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:image" content="${og}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${esc(ogTitle || title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta name="twitter:image" content="${og}">
  <script type="application/ld+json">${JSON.stringify(graph)}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" as="style" href="${FONTS}" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="${FONTS}"></noscript>
  <link rel="stylesheet" href="${CSS_V}">
  <script>document.documentElement.className='js'</script>
  <script src="${JS_V}" defer></script>
</head>
<body>
${nav(slug)}
<main id="main">
${body}
</main>
${FOOT}
</body>
</html>
`;
  const file = join(site, path === '/' ? 'index.html' : join(path, 'index.html'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  pages.push({ slug: slug || 'home', path, title, desc, ogTitle: ogTitle || title, ogSub: ogSub || desc });
  return html;
}
const pages = [];

// ---------- small builders ----------
const term = (cmd, copy = cmd) => `<div class="term"><span class="pr" aria-hidden="true">$</span><code>${cmd}</code><button type="button" data-copy="${esc(copy)}" aria-label="Copy the command">Copy</button></div>`;
const eyebrow = (t) => `<p class="eyebrow">${t}</p>`;
const faqHtml = (faq) => `<div class="faq rv">${faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}</div>`;
const list = (items) => `<ul class="list">${items.map(([b, s]) => `<li><b>${b}</b><span>${s}</span></li>`).join('')}</ul>`;
const gaps = (items) => `<div class="note"><p class="lbl" style="margin-bottom:8px">Known gaps in ${VERSION}</p><ul class="plain" style="margin:0;padding-left:1.1em">${items.map((x) => `<li style="margin:.3em 0">${x}</li>`).join('')}</ul></div>`;

// ---------- home ----------
const HOME_FAQ = [
  ['Is Vyre free?', 'Yes. Vyre is open source under Apache 2.0. You use your own Claude, Codex, Grok or OpenRouter account, so you pay those providers directly and nobody pays Vyre.'],
  ['Do I need a server?', 'Yes, one machine that stays on: a Linux server with Docker, or a Mac that stays on. Your Mac, your Windows PC and your phone connect to it. Your agents keep working when your laptop is closed.'],
  ['Does it run on Windows?', 'Yes, as an app on your PC with a tray icon and an Alt+Space panel. The server itself runs on Linux or on a Mac that stays on. The Windows app is not code-signed yet, so Windows asks you to choose “More info”, then “Run anyway”.'],
  ['Does it work on my phone?', 'Yes, on Android and iPhone. You install the Vyre app from a file (it is not on a store yet), scan the code your computer shows, and check that both screens show the same words.'],
  ['Where does my data live?', 'Sessions, memory and the vault stay on your machines. vyre.run holds your name’s DNS record and runs the relay, which carries phone pairing, end-to-end encrypted. Prompts go to your AI provider the way they would from that provider’s own app.'],
  ['Do I need a VPN or another network app?', 'No. Vyre has its own private network built in, so your server, your computers and your phone find each other with nothing to install and nothing to sign in to. Where a direct path is not possible, Vyre’s relay carries the connection, end-to-end encrypted.'],
  ['Does it replace Claude Code, Codex or Grok?', 'No. Vyre runs them with your own accounts and adds memory, a vault, teammates, watchers and one session that outlives any one model. You keep using each tool the way you do.'],
  ['What stops an agent from doing something I did not ask for?', 'Your own words are the approval: an action you asked for goes ahead, and one you did not ask for waits. Sends, posts and payments that no one asked for need Touch ID or Face ID, and the vault never shows a secret to an agent. Rules like these cannot be switched off by a setting.'],
  ['Is it ready?', `It is ${VERSION}, and what this page shows works today. Some things come next, and the <a href="/direction/">direction page</a> lists them. The <a href="https://github.com/vyre-ai/vyre/blob/main/docs/known-gaps.md">known gaps</a> list what ${VERSION} does not do yet.`],
];

const homeBody = `
<section class="hero" aria-labelledby="hero-h">
  <div class="wrap">
    <div class="copy">
      ${eyebrow('Open source. Apache 2.0. Your own subscriptions.')}
      <h1 id="hero-h" class="display">Your AI command center, <b>on your own machines.</b></h1>
      <p class="lead">Vyre runs your agents on a server you own, with Claude, Codex, Grok or OpenRouter in one session. Reach them from your Mac, your Windows PC or your phone.</p>
      <p class="hero-keep">Your agents keep working when your laptop is closed.</p>
      <div class="btn-row">
        <a class="btn btn-fill" href="/start/">Set up Vyre</a>
        <a class="btn" href="/direction/">See the direction</a>
      </div>
      <p class="hero-note">Free. Needs one AI account.</p>
    </div>
    <div class="stage">
      <canvas class="field" aria-hidden="true"></canvas>
      <div class="stage-in">
        <div class="stage-row">
          <div class="win lumen" id="demo" role="img" aria-label="Vyre Lumen on a Mac answering three requests: an answer from memory with its source, a switch to Codex for one message, and an email held for approval. Sample data.">
            <div class="win-bar"><i></i><i></i><i></i><span class="t">Vyre Lumen</span></div>
            <div class="body">
              <div class="ask"><span class="k">&#8997;Space</span><span><span class="q">what did Northwind ask for on the order form?</span><span class="caret"></span></span></div>
              <div class="scenes">
                <div class="scene on">
                  <div class="sends">Sends to <b>kit</b> &middot; Northwind Bakery</div>
                  <div class="ans" style="margin-top:12px"><div class="src"><span class="tag">From memory</span><span>no model used</span></div><p class="ah">Delivery by 9 am, two box sizes.</p><p>Northwind’s owner set it on the 12 Sep call. kit is checking the form against it today.</p><div class="why">Call, 12 Sep &middot; Northwind weekly &middot; turn 41 &nbsp;&#9166; open the source</div></div>
                </div>
                <div class="scene">
                  <div class="sends">Sends to <b>Codex</b> &middot; this message only</div>
                  <div class="ans" style="margin-top:12px"><div class="src"><span class="tag">Switched to Codex</span><span>same session</span></div><p class="ah">Renaming 6 fields in the intake form.</p><p>Codex has this session’s memory and files. The next message goes back to Claude.</p><div class="why">Answered by Codex &middot; your ChatGPT sign-in</div></div>
                </div>
                <div class="scene">
                  <div class="sends">Sends to <b>kit</b> &middot; Northwind Bakery</div>
                  <div class="ans" style="margin-top:12px"><div class="src"><span class="tag">Held for you</span><span>rule: email to a client waits</span></div><p class="ah">Draft to Northwind’s owner is ready.</p><p>“Hi Dana, the new order form is attached. Delivery windows now end at 9 am.”</p><div class="held"><span class="pill go">Send</span><span class="pill">Edit</span><span class="pill acc">Waiting on you &middot; 1</span></div></div>
                </div>
              </div>
              <div class="dots" aria-hidden="true"><i class="on"></i><i></i><i></i></div>
            </div>
          </div>
          <div class="phone" aria-hidden="true">
            <div class="notch"></div>
            <div class="scr">
              <div class="hdr"><span>alex.vyre.run</span><span>2 waiting</span></div>
              <p class="ph">Needs you</p>
              <div class="need">kit wants to email 14 Northwind customers the new order form<small>Held by rule: bulk email over 10</small><div class="acts"><span>Approve</span><span>Deny</span></div></div>
              <div class="need">Pay invoice 204, $320<small>Standing permission needs your touch</small></div>
              <div class="faceid">&#9679; Face ID to approve</div>
            </div>
          </div>
        </div>
        <p class="demo-tag">Sample data. Nothing you type here leaves this page.</p>
      </div>
    </div>
  </div>
</section>

<section class="works" id="devices" aria-labelledby="works-h">
  <div class="wrap">
    <p class="lbl" id="works-h" style="margin-bottom:14px">Works on</p>
    <div class="frame rv"><span class="pl-a">+</span><span class="pl-b">+</span>
      <div class="works-grid">
        <a href="/mac/">${I.mac}<b>Mac</b><span>Vyre Lumen opens over any app with Option-Space.</span><i class="go">Mac &rarr;</i></a>
        <a href="/windows/">${I.win}<b>Windows</b><span>Vyre Lumen in your tray, with an Alt+Space panel.</span><i class="go">Windows &rarr;</i></a>
        <a href="/linux/">${I.server}<b>Linux server</b><span>Where your agents live and keep working. A Mac that stays on works too.</span><i class="go">Server &rarr;</i></a>
        <a href="/phone/">${I.phone}<b>iPhone and Android</b><span>The Vyre app from a file, paired with Face ID or a fingerprint.</span><i class="go">Phone &rarr;</i></a>
      </div>
    </div>
  </div>
</section>

<section class="sec" id="why" aria-labelledby="why-h">
  <div class="wrap problem">
    <div class="art rv" aria-hidden="true"><canvas class="markart"></canvas></div>
    <div class="rv">
      ${eyebrow('The problem.')}
      <h2 id="why-h" class="h2">Your AI work lives in <b>someone else’s tabs.</b></h2>
      <p class="lead">Each AI account has its own app, its own memory and its own keys. Vyre keeps the work, the memory and the keys in one place you own.</p>
      <div class="pains">
        <div><h3>One app per AI</h3><p>Claude, Codex and Grok each keep their own history and their own keys. Switching means starting over.</p></div>
        <div><h3>An agent that stops when the lid closes</h3><p>An agent on your laptop sleeps when the laptop does. On your server it keeps working, and your phone is the way back in.</p></div>
      </div>
    </div>
  </div>
</section>

<section class="sec" id="product" aria-labelledby="pieces-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Stop starting over.')}
      <h2 id="pieces-h" class="h2">Plug in <b>what you need.</b></h2>
      <p class="lead">AI accounts, machines, people, agents and modules all connect the same way.</p>
    </div>
    <div class="pieces rv">
      <div class="piece"><span class="num">01</span>${I.ai}<h3>AI accounts</h3><p>Claude, Codex, Grok or OpenRouter, from the subscriptions you already pay for. Several per provider.</p></div>
      <div class="piece"><span class="num">02</span>${I.server}<h3>Machines</h3><p>A Linux server, a Mac that stays on, your Windows PC, your phone. One Vyre across them.</p></div>
      <div class="piece"><span class="num">03</span>${I.agents}<h3>Agents</h3><p>Teammates with roles and notes. Watchers that act within your rules. They hand work to each other.</p></div>
      <div class="piece"><span class="num">04</span>${I.modules}<h3>Modules</h3><p>The building blocks you or your agents add: tools, connections and screens.</p></div>
      <div class="piece"><span class="num">05</span>${I.people}<h3>People</h3><p>Next: team spaces, tagged Cloud, where a team shares a server and each person keeps their own. Your own space is Personal on your devices and My Cloud on your own server. See the <a href="/direction/">direction</a>.</p></div>
    </div>
  </div>
</section>

<section class="sec" id="lumen" aria-labelledby="lumen-h">
  <div class="wrap feat">
    <div class="feat-copy rv">
      <span class="num">01 &middot; Vyre Lumen</span>
      <h2 id="lumen-h" class="h2">Ask without leaving <b>what you’re doing.</b></h2>
      <p class="lead">Press Option-Space on a Mac or Alt+Space on Windows, over any app, and Vyre Lumen opens.</p>
      ${list([['@ anything', 'Name an agent or a project and the message goes there. The destination shows before you send.'], ['Answers from memory', 'If your memory already knows, you get the answer with its source, and no model is used.'], ['Watch it work', 'When an agent works on your Mac or in Chrome, Lumen shows the plan first and lets you pause, stop or edit a step.']])}
    </div>
    <div class="mock rv"><div class="win" role="img" aria-label="The Vyre Lumen oversight panel: kit is working in Chrome, with a plan of four steps, and buttons to pause or stop. Sample data.">
      <div class="win-bar"><i></i><i></i><i></i><span class="t">Vyre Lumen &middot; oversight</span></div>
      <div class="rows">
        <div class="row"><span class="mk vi">k</span><div class="grow"><b>kit is working in Chrome</b><small>Northwind order form &middot; step 3 of 4</small></div><span class="st on">working</span></div>
        <div class="row"><span class="mk sq">1</span><div class="grow">Open the order form<small>done</small></div><span class="st">&#10003;</span></div>
        <div class="row"><span class="mk sq">2</span><div class="grow">Replace the delivery times<small>done</small></div><span class="st">&#10003;</span></div>
        <div class="row"><span class="mk sq">3</span><div class="grow">Add the second box size<small>working</small></div><span class="st on">now</span></div>
        <div class="row"><span class="mk sq">4</span><div class="grow">Send the draft to you<small>waits for your yes</small></div><span class="st">held</span></div>
        <div class="row"><div class="grow"><span class="pill go">Pause</span> <span class="pill">Stop</span> <span class="pill">Edit a step</span></div></div>
      </div></div></div>
  </div>
</section>

<section class="sec" id="accounts" aria-labelledby="acc-h">
  <div class="wrap feat flip">
    <div class="feat-copy rv">
      <span class="num">02 &middot; Accounts</span>
      <h2 id="acc-h" class="h2">One session. <b>Every AI account you have.</b></h2>
      <p class="lead">A session belongs to Vyre, not to one model. Change the model whenever you like and it keeps its memory and its files.</p>
      ${list([['The model picker', 'Choose the provider, account, model and effort from the composer.'], ['@codex, @grok', 'Add a name to one message to ask another model. The session stays where it was.'], ['See who answered', 'Each reply carries its provider’s mark, and a line says “Switched to Grok” when the model changes.'], ['Images and video', 'What a model generates is saved in the project with its provider and prompt.']])}
    </div>
    <div class="mock rv"><div class="win" role="img" aria-label="The model picker listing Claude, Codex, Grok and OpenRouter, each from your own account. Sample data.">
      <div class="win-bar"><i></i><i></i><i></i><span class="t">Answer with</span></div>
      <div class="rows">
        <div class="row"><span class="mk">C</span><div class="grow"><b>Claude</b><small>Your Claude account</small></div><span class="st on">answering</span></div>
        <div class="row"><span class="mk">X</span><div class="grow"><b>Codex</b><small>Your ChatGPT sign-in</small></div><span class="st">@codex</span></div>
        <div class="row"><span class="mk">G</span><div class="grow"><b>Grok</b><small>Your xAI account</small></div><span class="st">@grok</span></div>
        <div class="row"><span class="mk">O</span><div class="grow"><b>OpenRouter</b><small>Your key &middot; any model it offers</small></div><span class="st"></span></div>
        <div class="sysline">Switched to Codex. It has this session’s memory and files.</div>
      </div></div></div>
  </div>
</section>

<section class="sec" id="agents" aria-labelledby="ag-h">
  <div class="wrap feat">
    <div class="feat-copy rv">
      <span class="num">03 &middot; Teammates and watchers</span>
      <h2 id="ag-h" class="h2">Agents with roles <b>that keep working.</b></h2>
      <p class="lead">A teammate is a named role with its own notes. It hands work to the next one, and watchers act within your rules.</p>
      ${list([['Teammates', 'A role inside a project, with a charter your agents draft and you edit. You can fill a role with one of your own agents.'], ['Watchers', 'They notice mail, calendar, repo and Slack events, or run on a schedule. Each shows a card before you turn it on: when, what it reads, whether it acts, what it costs.'], ['Inside a wall', 'A watcher runs with no home folder and no network of its own. If the wall is not available, it does not run and says why.']])}
    </div>
    <div class="mock rv"><div class="win" role="img" aria-label="A watcher card: when mail arrives from a client, check it against the project notes, draft a reply, and act only by drafting. Sample data.">
      <div class="win-bar"><i></i><i></i><i></i><span class="t">Watcher &middot; client mail</span></div>
      <dl class="kv">
        <dt>When</dt><dd>A client email arrives</dd>
        <dt>Check</dt><dd>Is it about an open order?</dd>
        <dt>Do</dt><dd>Draft a reply, held for you</dd>
        <dt>Reads</dt><dd>Inbox, project notes</dd>
        <dt>Acts</dt><dd>No. It drafts only.</dd>
        <dt>Cost</dt><dd>A few cents a run, capped daily</dd>
      </dl>
      <div class="sysline">Owned by teammate <b>kit</b> &middot; hands drafts to <b>juno</b></div>
    </div></div>
  </div>
</section>

<section class="sec" id="approval" aria-labelledby="ap-h">
  <div class="wrap feat flip">
    <div class="feat-copy rv">
      <span class="num">04 &middot; Asking is approving</span>
      <h2 id="ap-h" class="h2">Your words <b>are the approval.</b></h2>
      <p class="lead">When you ask for something, that is the yes. Touch ID or Face ID is only for pairing, vault secrets and anything that sends, posts or pays on its own.</p>
      ${list([['No pop-up for what you asked', 'An action that matches your request goes ahead. An action nobody asked for waits.'], ['A floor no setting removes', 'Some rules cannot be switched off, and an agent cannot loosen one without telling you, with an Undo.'], ['Signed releases', 'Updates are checked against a pinned key. A box refuses an unsigned or older release and keeps running.']])}
    </div>
    <div class="mock rv"><div class="win" role="img" aria-label="Two requests. The first, which you asked for, goes ahead. The second, a payment nobody asked for, waits for Face ID. Sample data.">
      <div class="win-bar"><i></i><i></i><i></i><span class="t">Session &middot; Northwind</span></div>
      <div class="msg"><div class="who"><span class="mk" style="width:20px;height:20px;font-size:9px">A</span>You</div>Send Northwind the new order form.</div>
      <div class="msg"><div class="who"><span class="mk vi" style="width:20px;height:20px;font-size:9px">k</span>kit</div>Sent. You asked for it, so it went straight out. <span class="pill ok" style="margin-left:6px">done</span></div>
      <div class="msg"><div class="who"><span class="mk vi" style="width:20px;height:20px;font-size:9px">k</span>kit</div>A supplier invoice is due: $320. Nobody asked me to pay it, so it waits. <div class="held"><span class="pill acc">&#9679; Face ID to approve</span><span class="pill">Deny</span></div></div>
    </div></div>
  </div>
</section>

<section class="sec" id="memory" aria-labelledby="mem-h">
  <div class="wrap feat">
    <div class="feat-copy rv">
      <span class="num">05 &middot; Memory and vault</span>
      <h2 id="mem-h" class="h2">It remembers, <b>and shows you where from.</b></h2>
      <p class="lead">Every session goes into your memory, and a recalled answer shows its source.</p>
      ${list([['Ask why', 'A recalled answer opens the call, the thread or the turn it came from. Anything else came from the model, and says so.'], ['A vault, on your server', 'Logins, one-time codes and API keys are sealed on your own machine. Agents use a credential without ever seeing it.'], ['Share and take back', 'Share one item, then revoke it in one step.']])}
    </div>
    <div class="mock rv"><div class="win" role="img" aria-label="A memory answer with its source, and a vault item whose value stays sealed. Sample data.">
      <div class="win-bar"><i></i><i></i><i></i><span class="t">Memory</span></div>
      <div class="msg"><div class="who">You</div>When does Northwind want the drafts, and in what format?</div>
      <div class="msg"><div class="who"><span class="pill acc">Recalled</span> Northwind weekly, 3 Mar &middot; no model used</div><b>Friday before noon.</b> PDFs named by order number, sent to the team inbox.<div class="why" style="margin-top:8px;font:400 12px var(--mono);color:var(--ink-3)">Why? Open turn 41</div></div>
      <div class="sysline">Vault</div>
      <div class="row"><span class="mk sq">&#128274;</span><div class="grow"><b>Northwind billing portal</b><small>Login &middot; one-time code</small></div><span class="sealed">&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;</span></div>
      <div class="row"><div class="grow"><small>kit used it for the 9 am export. It never saw the value.</small></div></div>
    </div></div>
  </div>
</section>

<section class="sec" id="phone" aria-labelledby="ph-h">
  <div class="wrap feat flip">
    <div class="feat-copy rv">
      <span class="num">06 &middot; Phone</span>
      <h2 id="ph-h" class="h2">Your pocket, <b>paired with Face ID.</b></h2>
      <p class="lead">Open Vyre on your phone and pair it by scanning a code.</p>
      ${list([['Needs rows', 'Approve, deny or answer by swipe. Push tells you when an agent is waiting.'], ['Chats, agents, Find and Drive', 'Browse your shared folders and ask your memory from the same app.'], ['A removed phone wipes itself', 'Remove a device and it is cut off and clears what it kept.']])}
      <p class="sm" style="margin-top:18px">Nothing else to install. <a href="/phone/">More on the phone app</a></p>
    </div>
    <div class="mock rv" style="display:flex;justify-content:center"><div class="phone" style="width:min(100%,300px)" role="img" aria-label="The Vyre phone app on the Needs screen, with two items waiting. Sample data.">
      <div class="notch"></div>
      <div class="scr">
        <div class="hdr"><span>alex.vyre.run</span><span>online</span></div>
        <p class="ph">Needs you</p>
        <div class="need">kit wants to email 14 Northwind customers the new order form<small>Held by rule: bulk email over 10 &middot; 18 min</small><div class="acts"><span>Approve</span><span>Deny</span></div></div>
        <div class="need">juno drafted a reply to Northwind<small>Q3 report &middot; email to a client &middot; 6 min</small></div>
        <div class="need">Which export format should kit use?<small>A question from kit</small></div>
        <div class="faceid">&#9679; Face ID to approve</div>
      </div></div></div>
  </div>
</section>

<section class="sec" id="open" aria-labelledby="open-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('What it costs.')}
      <h2 id="open-h" class="h2">Free, open source, <b>on your machines.</b></h2>
      <p class="lead">Vyre is Apache 2.0 and runs on your server. You pay your AI providers, not us.</p>
    </div>
    <div class="cost rv">
      <div><p class="lbl">Vyre</p><p class="big">Free</p><p>Apache 2.0. Read it, change it, run it. Your data lives on your devices and on servers you or your team run. Vyre doesn't hold it. A Cloud space is a server you or your team chose, not ours. A Vyre-hosted home for people without a server may come later, and it would be optional.</p></div>
      <div><p class="lbl">Your AI</p><p class="big">Your plans</p><p>Claude, Codex, Grok or OpenRouter, on the subscriptions or keys you already have.</p></div>
      <div><p class="lbl">Your machine</p><p class="big">One server</p><p>A Linux server with Docker, or a Mac that stays on.</p></div>
    </div>
  </div>
</section>

<section class="sec" id="install" aria-labelledby="in-h">
  <div class="wrap feat">
    <div class="feat-copy rv">
      <span class="num">Get started</span>
      <h2 id="in-h" class="h2">One line on your server, <b>then pair it from the app.</b></h2>
      <p class="lead">Reserve your name, install the app, and add a server: the app gives you one line to paste on it and checks four words with you.</p>
      <div class="btn-row"><a class="btn btn-fill" href="/start/">Read the steps</a></div>
    </div>
    <div class="rv">
      <ol class="steps" style="margin-top:0">
        <li><b>Open the Vyre app.</b> Choose your name and create a space.</li>
        <li><b>Paste the line on your server.</b> It asks before it installs anything, including Docker.
          ${term('curl -fsSL vyre.run/i | sh', 'curl -fsSL vyre.run/i | sh')}</li>
        <li><b>Check four words in the app.</b> The server prints four words and the app shows four; you confirm they match.</li>
        <li><b>Add your computers.</b> Vyre Lumen for <a href="/mac/">Mac</a> and <a href="/windows/">Windows</a> pairs to your server.</li>
      </ol>
    </div>
  </div>
</section>

<section class="sec" id="direction" aria-labelledby="dir-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Where Vyre is going.')}
      <h2 id="dir-h" class="h2">Direction. <b>Not a promise of dates.</b></h2>
      <p class="lead">This is direction, not a promise of dates. What is in 0.2.9, what comes next, and what comes later.</p>
    </div>
    <div class="pieces rv" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
      <div class="piece"><span class="num">Now &middot; 0.2.9</span><h3>Spaces</h3><p>Personal on your devices, My Cloud on your own server, and Cloud spaces for teams.</p></div>
      <div class="piece"><span class="num">Now &middot; 0.2.9</span><h3>Records</h3><p>Contacts, projects, tasks and anything you define, with flows and watchers to run them.</p></div>
      <div class="piece"><span class="num">Now &middot; 0.2.9</span><h3>Chats</h3><p>One place for you, your team and every AI model, with each chat encrypted to the people in it.</p></div>
      <div class="piece"><span class="num">Now &middot; 0.2.9</span><h3>A built-in network</h3><p>Pair a device with one typed code, with no VPN to install.</p></div>
      <div class="piece"><span class="num">Now &middot; 0.2.9</span><h3>Lend a computer</h3><p>Lend a computer to a team; your work on it is encrypted at rest on your computer and on the server, and deleted from your computer when access ends.</p></div>
      <div class="piece"><span class="num">Next &middot; 0.3.1</span><h3>Screen Share</h3><p>Watch and take over your agents\' computers and Chrome, on every device.</p></div>
      <div class="piece"><span class="num">Later</span><h3>A Vyre-hosted home</h3><p>A Vyre-hosted home for people without a server.</p></div>
    </div>
    <div class="btn-row"><a class="btn" href="/direction/">Read the direction</a></div>
  </div>
</section>

<section class="sec" id="faq" aria-labelledby="faq-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Any questions?')}
      <h2 id="faq-h" class="h2">Straight answers, <b>yes or no first.</b></h2>
    </div>
    ${faqHtml(HOME_FAQ)}
  </div>
</section>

<section class="closing" aria-labelledby="end-h">
  <div class="wrap">
    <h2 id="end-h" class="display">Let’s get <b>to work.</b></h2>
    <div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="${REPO}">${STAR}Star on GitHub</a><a class="btn" href="${REPO}">Read the source</a></div>
  </div>
</section>`;

page({
  slug: '', path: '/',
  title: 'Vyre: your AI command center, on your own machines',
  desc: 'Open-source command center that runs your AI agents on a server you own. One session across Claude, Codex, Grok and OpenRouter, reached from your Mac, your Windows PC or your phone.',
  ogTitle: 'Your AI command center, on your own machines.',
  ogSub: 'Your agents run on a server you own, with Claude, Codex, Grok or OpenRouter in one session. Reach them from your Mac, your Windows PC or your phone.',
  body: homeBody, ld: [SOFT(), { '@type': 'WebSite', '@id': `${SITE}/#site`, url: `${SITE}/`, name: 'Vyre', publisher: { '@id': `${SITE}/#org` } }, faqLd(HOME_FAQ)],
});

// ---------- device pages ----------
function devicePage({ slug, os, name, crumb, h1, lead, ogSub, desc, title, art, what, steps, needs, gapList, faq, extra = '' }) {
  const path = `/${slug}/`;
  const body = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / ${crumb}</p>
    ${eyebrow(name)}
    <h1 class="display">${h1}</h1>
    <p class="lead">${lead}</p>
    <div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="/start/">Read the steps</a></div>
  </div>
</section>
${art ? `<section class="sec" style="padding-top:56px"><div class="wrap"><div class="rv" style="max-width:880px;margin-inline:auto">${art}</div></div></section>` : ''}
<section class="sec" aria-labelledby="what-h">
  <div class="wrap feat">
    <div class="feat-copy rv"><span class="num">What you get</span><h2 id="what-h" class="h2">${what.h}</h2>${what.lead ? `<p class="lead">${what.lead}</p>` : ''}</div>
    <div class="rv">${list(what.items)}</div>
  </div>
</section>
<section class="sec" aria-labelledby="steps-h">
  <div class="wrap feat flip">
    <div class="feat-copy rv"><span class="num">Install</span><h2 id="steps-h" class="h2">${steps.h}</h2>${steps.lead ? `<p class="lead">${steps.lead}</p>` : ''}</div>
    <div class="rv"><ol class="steps" style="margin-top:0">${steps.items.map((s) => `<li>${s}</li>`).join('')}</ol></div>
  </div>
</section>
<section class="sec" aria-labelledby="need-h">
  <div class="wrap">
    <div class="sec-head rv"><span class="lbl" id="need-h">What it needs</span></div>
    <div class="need-list rv">${needs.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('')}</div>
    ${extra}
    <div class="rv" style="margin-top:36px">${gaps(gapList)}</div>
  </div>
</section>
<section class="sec" aria-labelledby="faq-h">
  <div class="wrap"><div class="sec-head rv"><h2 id="faq-h" class="h2">Questions about <b>${name}.</b></h2></div>${faqHtml(faq)}</div>
</section>
<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">Set up <b>Vyre.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/start/">Read the steps</a><a class="btn" href="/">Back to vyre.run</a></div></div></section>`;
  page({
    slug, path, title, desc, body, ogTitle: h1.replace(/<[^>]+>/g, ''), ogSub,
    ld: [SOFT({ '@id': `${SITE}${path}#app`, name: `Vyre for ${crumb}`, url: SITE + path, operatingSystem: os }), crumbs([['Vyre', `${SITE}/`], [crumb, SITE + path]]), faqLd(faq)],
  });
}

devicePage({
  slug: 'mac', os: 'macOS', name: 'Vyre Lumen on Mac', crumb: 'Mac',
  title: 'Vyre for Mac: Vyre Lumen, one key from any app',
  desc: 'Vyre Lumen is the ask window for your Mac. Press Option-Space over any app, send a message to an agent, and get answers from your memory. Your agents run on your own server.',
  h1: 'Vyre Lumen, <b>one key away on your Mac.</b>',
  lead: 'Press Option-Space over any app. Ask, send to an agent, or pull an answer from your memory. Your agents run on your server, and Lumen is the window.',
  ogSub: 'Press Option-Space over any app. Ask, send to an agent, or pull an answer from your memory.',
  art: `<div class="win" role="img" aria-label="Vyre Lumen on a Mac. Sample data."><div class="win-bar"><i></i><i></i><i></i><span class="t">Vyre Lumen</span></div><div class="body" style="padding:18px 20px 20px"><div class="ask"><span class="k">&#8997;Space</span><span>@kit the Northwind form needs the new box size</span></div><div class="sends" style="margin-top:12px">Sends to <b>kit</b> &middot; Northwind Bakery &middot; then a draft, held for you</div></div></div><p class="demo-tag">Sample data.</p>`,
  what: { h: 'A small window, <b>over everything.</b>', items: [
    ['Option-Space, or Control twice', 'Opens over any app, a call or a doc. Esc closes it.'],
    ['@ an agent or a project', 'The message goes there, and the destination shows before you send.'],
    ['Answers from memory', 'If your memory knows, you get the answer with its source. No model is used.'],
    ['Oversight', 'When an agent works on your Mac or in Chrome, Lumen shows the plan, and you can pause, stop, edit a step or say something.'],
    ['Touch ID', 'Unlock your vault with Touch ID or your vault password.'],
    ['Your keys', 'Your own shortcuts, # tags, module commands and spoken replies.'],
  ] },
  steps: { h: 'Install the command line, <b>then build Lumen.</b>', lead: 'Set up your server first, from the Vyre app (see <a href="/start/">Get started</a>). Then, on your Mac:', items: [
    `<b>Install the command line.</b> Vyre is not on npm yet, so it installs from a tarball on vyre.run.${term('npm i -g https://vyre.run/box/vyre.tgz')}`,
    `<b>Pair this Mac with your server.</b> It asks for your server’s pairing code, shows three words, and pairs once you confirm they match on both screens.${term('vyre up')}`,
    `<b>Build Vyre Lumen.</b> It builds from the package on your Mac; nothing is downloaded. If it asks for the Command Line Tools, run <code>xcode-select --install</code> first.${term('vyre capsule install')}`,
    `<b>Press Option-Space.</b> No extra permission is needed. Control twice needs Input Monitoring.`,
  ] },
  needs: [['Mac', 'macOS, with Node 22.5 or newer'], ['Server', 'A Linux server, or another Mac that stays on'], ['AI', 'One of Claude, Codex, Grok or OpenRouter']],
  extra: `<p class="lead rv" style="margin-top:28px">A Mac that stays on can be your server too. The same setup line works there.</p>`,
  gapList: ['Lumen is built on your Mac, not downloaded. There is no signed Mac download yet.', 'Lumen is self-signed, not notarized, so macOS may ask for your permissions again after an update. Notarization comes next.', 'Lumen has no AI presets or browser tabs yet, and its text snippets paste when you press Enter rather than expanding as you type.', 'The Mac server installer has not run on a real Mac yet.'],
  faq: [
    ['Do I need the Mac app to use Vyre?', 'No. Your agents run on your server and the Vyre app opens in any browser. Lumen is the fastest way to ask from your Mac.'],
    ['Can my Mac be the server?', 'Yes, a Mac that stays on can be the server. A Linux server is the best home, because agents keep working when a laptop sleeps.'],
    ['Why does it build instead of download?', 'There is no signed Mac download yet. Building on your Mac from the package means nothing unsigned is installed. A notarized download comes next.'],
    ['Does Lumen need Touch ID?', 'Only to unlock your vault. Asking and sending what you asked for do not.'],
  ],
});

devicePage({
  slug: 'windows', os: 'Windows', name: 'Vyre Lumen on Windows', crumb: 'Windows',
  title: 'Vyre for Windows: Vyre Lumen in your tray',
  desc: 'Vyre Lumen for Windows is a tray app with an Alt+Space panel. Pair your PC to your own Vyre server, ask your agents, and map your shared folder as a drive.',
  h1: 'Vyre Lumen, <b>in your Windows tray.</b>',
  lead: 'A tray icon and an Alt+Space panel, connected to your Vyre server. Pair a PC with 13 words or a QR code from your other device.',
  ogSub: 'A tray icon and an Alt+Space panel, connected to your own Vyre server.',
  art: `<div class="win" role="img" aria-label="The Vyre Lumen panel on Windows. Sample data."><div class="win-bar"><i></i><i></i><i></i><span class="t">Vyre Lumen</span></div><div class="body" style="padding:18px 20px 20px"><div class="ask"><span class="k">Alt+Space</span><span>what did Northwind ask for on the order form?</span></div><div class="sends" style="margin-top:12px">From memory &middot; no model used &middot; Call, 12 Sep</div></div></div><p class="demo-tag">Sample data.</p>`,
  what: { h: 'The same window, <b>on your PC.</b>', items: [
    ['A tray app', 'A Lumen icon in your tray, and an Alt+Space panel to ask from.'],
    ['Pair with 13 words or a QR code', 'Type the words or scan the code from your other device, then confirm the server’s address and key fingerprint.'],
    ['Your shared folder as a drive', 'The tray’s “Open Vyre Drive” maps a folder your server shares as a drive letter.'],
    ['Signed updates', 'The app updates itself, only from releases the Vyre key signed, and never to an older version.'],
  ] },
  steps: { h: 'Install the app, <b>then pair your PC.</b>', lead: 'Set up your server first, from the Vyre app (see <a href="/start/">Get started</a>).', items: [
    `<b>Download the installer.</b> <code>VyreSetup.exe</code> comes with each release on <a href="https://github.com/vyre-ai/vyre/releases">GitHub</a>. The installer script checks its SHA-256.`,
    `<b>Run it.</b> The app is not code-signed yet, so Windows asks you to choose “More info”, then “Run anyway”.`,
    `<b>Pair your PC.</b> In Settings on your other device, add a Windows PC, then type the 13 words or scan the QR code on the PC.`,
    `<b>Press Alt+Space.</b> Ask from anywhere, or open the tray icon.`,
  ] },
  needs: [['PC', 'Windows 11'], ['Server', 'A Linux server, or a Mac that stays on'], ['AI', 'One of Claude, Codex, Grok or OpenRouter']],
  gapList: ['The app is not code-signed (Authenticode) yet, so Windows warns on first run. Signing comes next.', 'Mapping the drive for files over 50 MB needs a registry change by an administrator.', 'A Windows PC is not a home in 0.2.9 and runs no sessions of its own: your PC is a client of a server, a Linux machine or a Mac. The Windows home comes in 0.3.0.'],
  faq: [
    ['Can my Windows PC be the server?', 'Not in 0.2.9. A home runs on a Mac, Linux or a server, and your Windows PC connects to it as a client. The Windows home comes in 0.3.0.'],
    ['Why does Windows warn me?', 'The app is not code-signed yet. The installer script checks its SHA-256, and updates install only when the Vyre release key signed them.'],
    ['How do I pair a PC?', 'In Settings on a device you already use, add a Windows PC. Type the 13 words or scan the QR code on the PC, then confirm the server’s address and fingerprint.'],
    ['Is there an Alt+Space conflict?', 'The panel opens with Alt+Space. If another app uses that key, change one of them in its settings.'],
  ],
});

devicePage({
  slug: 'linux', os: 'Linux', name: 'Vyre on a Linux server', crumb: 'Linux server',
  title: 'Vyre on a Linux server: your agents keep working',
  desc: 'Install Vyre on a Linux server you own. One line from the Vyre app, signed images and updates, and your agents keep working when your laptop is closed.',
  h1: 'Your server is <b>where Vyre lives.</b>',
  lead: 'Install Vyre on a Linux machine you control. Your agents run there and keep working when your laptop is closed. Your Mac, your PC and your phone are the ways in.',
  ogSub: 'One line from the Vyre app. Signed images and updates. Your agents keep working when your laptop is closed.',
  what: { h: 'A home for your agents, <b>that you own.</b>', items: [
    ['One line, then the app', 'The Vyre app gives you a line to paste on your server. The server prints four words, the app shows four, and you confirm they match.'],
    ['Checked before it runs', 'The installer asks before installing anything, checks what it downloads against a published signature, and pulls images by digest after their signatures are checked.'],
    ['Updates that cannot go backwards', 'A box refuses an unsigned, wrongly signed, tampered or older release, and keeps running as it was. Stable never takes a test version.'],
    ['Your name, your domain', 'Reach it at you.vyre.run, or serve it under your own domain.'],
    ['Backup and removal', 'Export and import a server, back up, restore, and uninstall with or without your data.'],
  ] },
  steps: { h: 'Open the app, <b>paste one line.</b>', items: [
    `<b>Open the Vyre app.</b> Choose your name, create a space and choose a server. The app shows one line to run.`,
    `<b>Paste it on your server</b>, as yourself, not as root.${term('curl -fsSL vyre.run/i | sh', 'curl -fsSL vyre.run/i | sh')}`,
    `<b>Check the words.</b> The server prints four words. The app finds it and shows four; confirm they match.`,
    `<b>Finish in the app.</b> Give the space a look, connect your AI account and your tools, and pick a Kit or start empty.`,
  ] },
  needs: [['Server', 'A Linux machine with sudo and Docker Compose 2.24 or newer. The installer asks before adding Docker.'], ['Size', 'One space per server. A 4 GB server runs one space; Vyre sizes it for you. 8 GB is comfortable and leaves room to grow.'], ['AI', 'One of Claude, Codex, Grok or OpenRouter'], ['Where', 'Installs in /srv/vyre']],
  gapList: ['The first Windows install is not signature-checked; the server install is.', 'Idle sessions do not sleep under memory pressure yet, and there is no fair-share scheduler for many sessions on one server.', 'Home-router NAT is untested: a direct path through a home router has not been tried, and the relay carries the connection when there is none.', 'The Mac server installer has not run on a real Mac yet.'],
  faq: [
    ['What server do I need?', 'A Linux machine you can ssh into with sudo. A small cloud machine or a spare computer both work. Docker Compose 2.24 or newer is required, and the installer offers to add Docker.'],
    ['Can I use a Mac as the server?', 'Yes, a Mac that stays on. Run the same line in Terminal on that Mac.'],
    ['How do I start over?', 'Run the installer with --uninstall to remove Vyre and keep your data, or add --purge to delete the vault, sign-ins and projects too.'],
    ['What does vyre.run hold?', 'Your name’s DNS record and the relay that carries setup progress and phone pairing, end-to-end encrypted. Your sessions, memory and vault stay on your server.'],
  ],
});

devicePage({
  slug: 'phone', os: 'iOS, Android', name: 'Vyre on your phone', crumb: 'Phone',
  title: 'Vyre on your phone: your agents in your pocket',
  desc: 'Put the Vyre app on your Android phone from the release file, or on your iPhone from a build you install with Xcode, and pair it by scanning a code. Approve, deny and answer from anywhere.',
  h1: 'Your agents, <b>in your pocket.</b>',
  lead: 'Install the Vyre app from a file, scan a code to pair it, and approve what your agents wait on with Face ID or a fingerprint.',
  ogSub: 'Install the Vyre app from a file, scan a code to pair, and approve what your agents wait on.',
  art: `<div style="display:flex;justify-content:center"><div class="phone" style="width:min(100%,290px)" role="img" aria-label="The Vyre phone app, Needs screen. Sample data."><div class="notch"></div><div class="scr"><div class="hdr"><span>alex.vyre.run</span><span>2 waiting</span></div><p class="ph">Needs you</p><div class="need">kit wants to email 14 Northwind customers the new order form<small>Held by rule: bulk email over 10</small><div class="acts"><span>Approve</span><span>Deny</span></div></div><div class="need">Which export format should kit use?<small>A question from kit</small></div><div class="faceid">&#9679; Face ID to approve</div></div></div></div><p class="demo-tag">Sample data.</p>`,
  what: { h: 'Vyre, <b>in your pocket.</b>', items: [
    ['Now, Chats, Agents, Find, Drive', 'Ask your memory from Find. Browse the folders your server shares from Drive.'],
    ['Needs rows', 'Approve, deny or answer by swipe. Open the app to see what is waiting.'],
    ['A full device', 'A phone paired by scanning makes its own Face ID key at that moment. No code typed on your computer.'],
    ['Face ID only when it matters', 'It is asked for the vault and for sends you did not ask for.'],
    ['A removed phone wipes itself', 'Remove a device and it is cut off and clears what it kept. The release signs the app’s files, so a changed file is refused.'],
  ] },
  steps: { h: 'Install the file, <b>then scan.</b>', items: [
    `<b>Install the app.</b> Android: download Vyre-android.apk from the <a href="https://github.com/vyre-ai/vyre/releases/latest">latest release</a> on the phone, open it, and allow installs when Android asks. iPhone: there is no App Store app yet; build the app and install it with Xcode, as the <a href="https://github.com/vyre-ai/vyre/blob/main/docs/using/mobile.md">phone guide</a> shows. Both are sideloaded.`,
    `<b>Scan the code.</b> In the Vyre app on your computer, choose Add your phone. It shows a code. Scan it with the phone.`,
    `<b>Confirm the words.</b> The phone and the computer show the same words. Say yes only if they match.`,
  ] },
  needs: [['Phone', 'An Android phone, or an iPhone and a Mac with Xcode'], ['Server', 'A Vyre server'], ['Account', 'Your own address, such as you.vyre.run']],
  gapList: ['Nothing has been walked on a real iPhone or Android yet, including Face ID pairing and the removed-phone wipe.', 'Notifications to a closed phone app are not set up: Apple and Google push accounts are needed. Open the app to see what is waiting.', 'Screen Share (live view and computer use) comes in 0.3.1; Chrome control works today.'],
  faq: [
    ['Is there an App Store app?', 'Not yet. On Android you install the APK from the release page; on iPhone you build the app and install it with Xcode. Both are sideloaded.'],
    ['Does the phone need a VPN?', 'No. The phone reaches your server through Vyre’s own network, and where a direct path is not possible, through the relay. Your identity on the phone is a key that Face ID unlocks, so there is no separate login to the server.'],
    ['What happens if I lose my phone?', 'Remove it from another device. It is cut off from your server, and it wipes what it kept when it next opens.'],
    ['Do I get notifications?', 'Not when the app is closed, yet. Open the app and Now lists what is waiting for you.'],
  ],
});

// ---------- direction ----------
const DIR = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Direction</p>
    ${eyebrow('Where Vyre is going.')}
    <h1 class="display">Where Vyre <b>is going.</b></h1>
    <p class="lead">This page is direction, not a promise of dates. It is what we are building toward, in the order we expect to build it.</p>
  </div>
</section>
<section class="sec" style="padding-top:64px" aria-labelledby="road-h">
  <div class="wrap">
    <h2 id="road-h" class="lbl" style="margin-bottom:28px">The road from ${VERSION}</h2>
    <div class="road">
      <div class="stop now rv"><p class="ver">${VERSION} &middot; Now</p><h3>The first release of the 0.3 work</h3><p>0.2.9 is the first release of the 0.3 work: Spaces, Wink, the objects layer and the one-yes approvals.</p><ul><li><b>Spaces</b>Personal on your devices, My Cloud on your own server, and Cloud spaces for teams.</li><li><b>Records</b>Contacts, projects, tasks and anything you define, with flows and watchers to run them.</li><li><b>Chats</b>One place for you, your team and every AI model, with each chat encrypted to the people in it.</li><li><b>A built-in network</b>Pair a device with one typed code, with no VPN to install.</li><li><b>Lend a computer</b>Lend a computer to a team; your work on it is encrypted at rest on your computer and on the server, and deleted from your computer when access ends.</li></ul></div>
      <div class="stop rv"><p class="ver">Next &middot; 0.3.1</p><h3>Screen Share</h3><p>Watch and take over your agents\' computers and Chrome, on every device.</p></div>
      <div class="stop rv"><p class="ver">Later</p><h3>A Vyre-hosted home</h3><p>A Vyre-hosted home for people without a server.</p></div>
    </div>
  </div>
</section>
<section class="sec" aria-labelledby="same-h">
  <div class="wrap feat">
    <div class="feat-copy rv"><span class="num">What does not change</span><h2 id="same-h" class="h2">The rules <b>stay where they are.</b></h2></div>
    <div class="rv">${list([['Your machines', 'Vyre runs on hardware you control. Your data lives on your devices and on servers you or your team run. Vyre doesn\'t hold it. A Cloud space is a server you or your team chose, not ours.'], ['Your accounts', 'Your own AI subscriptions and keys. Several per provider.'], ['Asking is approving', 'Your own words are the yes, and some rules no setting removes.'], ['Your own work only', 'A person’s computer never runs someone else’s work.'], ['Nothing feels walled off', 'The separation is in how it is built, not in how it feels to use.']])}</div>
  </div>
</section>
<section class="sec" aria-labelledby="note-h">
  <div class="wrap"><div class="note rv"><p class="lbl" id="note-h" style="margin-bottom:8px">A plain note</p><p style="margin:0">This is direction, not a promise of dates. Order and scope can change when we learn something. The <a href="https://github.com/vyre-ai/vyre/releases">releases</a> and the <a href="https://github.com/vyre-ai/vyre/blob/main/docs/known-gaps.md">known gaps</a> are what is true today.</p></div></div>
</section>
<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">Start with <b>what works today.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="/">Back to vyre.run</a></div></div></section>`;
page({
  slug: 'direction', path: '/direction/',
  title: 'Where Vyre is going: the direction',
  desc: 'The direction for Vyre from 0.2.9: spaces, records, chats, a built-in network and lending a computer, then Screen Share, then a Vyre-hosted home. Direction, not a promise of dates.',
  ogTitle: 'Where Vyre is going.', ogSub: 'Spaces, records, chats, a built-in network, then Screen Share. Direction, not a promise of dates.',
  body: DIR, ld: [crumbs([['Vyre', `${SITE}/`], ['Direction', `${SITE}/direction/`]])],
});

// ---------- start page ----------
const part = (n, id, h, inner) => `<section class="part rv" id="${id}" aria-labelledby="${id}-h"><span class="n">${n}</span><div><h2 id="${id}-h">${h}</h2>${inner}</div></section>`;
const START = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Get started</p>
    ${eyebrow('Getting started')}
    <h1 class="display">Start with <b>your name.</b></h1>
    <p class="lead">Reserve your name, put the Vyre app on your computer, and the app does the rest.</p>
    <p class="sm" style="max-width:42em">The Mac and Android apps are not signed with a store or Apple identity yet, so you install them from the file (sideload). Every file in a release is checked against a published signature.</p>
  </div>
</section>
<section class="sec" style="padding-top:48px"><div class="wrap">
${part('00', 'need', 'What you need', `<ul>
<li>A Mac or a Windows PC for the app.</li>
<li>An account with at least one of Claude, Codex, Grok or OpenRouter.</li>
<li>To add a server: a Linux machine (a cloud machine is fine) or a Mac that stays on. With Records, which is recommended, it needs 8 GB of memory (4 GB at the least); without Records, 2 GB.</li>
<li>To join a team: the invite your team sent you.</li></ul>`)}
${part('01', 'name', 'Reserve your name', `<p>Open <a href="/setup/">vyre.run/setup</a>, type the name you want and press <strong>Reserve this name</strong>. The page shows a code that starts with VYRE. Copy it. It is held for you for 24 hours and works once.</p>`)}
${part('02', 'app', 'Install the app', `<p><strong>Mac:</strong> download <a href="https://github.com/vyre-ai/vyre/releases/latest">Vyre-Lumen-aarch64.dmg</a> (Apple silicon) or Vyre-Lumen-x86_64.dmg (Intel), open it and drag Vyre Lumen to Applications. Open it once; if macOS says it cannot check the app, choose Open Anyway in System Settings, Privacy and Security. More on the <a href="/mac/">Mac page</a>.</p>
<p><strong>Windows:</strong> download VyreSetup.exe from the <a href="https://github.com/vyre-ai/vyre/releases/latest">latest release</a> and run it. If Windows warns that the publisher is unknown, choose <em>More info</em>, then <em>Run anyway</em>. More on the <a href="/windows/">Windows page</a>.</p>`)}
${part('03', 'code', 'Paste the code', `<p>Open the app, choose <strong>Start</strong> and paste the code. The app makes your key on this computer and shows a recovery code once. Keep it somewhere only you can reach.</p>`)}
${part('04', 'choose', 'Choose how you will use Vyre', `<ul>
<li><strong>Join a team.</strong> Paste your team’s invite. You run on their server and need none of your own.</li>
<li><strong>Add a server.</strong> A machine of your own that stays on: a Linux server, or a Mac. Choose <em>With Records</em> (recommended) or <em>Without Records</em> (a small server).</li>
<li><strong>Use My Home</strong> (Mac only). Vyre runs on this Mac while it is awake. Add a server later and everything moves across.</li></ul>`)}
${part('05', 'server', 'Add a server', `<p>The app shows one line. Open a terminal on the server as yourself, not as root, and paste it. It looks like this:</p>
${term('curl -fsSL vyre.run/i | VYRE_CODE=… VYRE_STORE=auto sh', 'curl -fsSL vyre.run/i | VYRE_CODE=… VYRE_STORE=auto sh')}
<p>On a Mac that stays on, the app shows the Mac line instead, and the Mac asks for its password once so Vyre can start when the Mac starts. The line is good for one hour and works once.</p>
<p>The installer checks the release’s signature, sets Vyre up, and prints four words. The app finds your server by itself and shows four words too. If they match, choose <strong>They match</strong>. Nothing is connected until you do.</p>`)}
${part('06', 'phone', 'Add your phone', `<p>From the app, choose <strong>Add your phone</strong>. On Android, download <a href="https://github.com/vyre-ai/vyre/releases/latest">Vyre-android.apk</a> on the phone and open it; allow installs from your browser or Files app when Android asks. On iPhone there is no App Store app yet: you build the app and install it with Xcode. Scan the code from your computer and check that both screens show the same words. More on the <a href="/phone/">phone page</a>.</p>`)}
${part('!', 'not-finished', 'What is not in ' + VERSION, `<ul>
<li><strong>Real devices.</strong> Nothing has been walked on a real iPhone or Android yet, including Face ID pairing and the removed-phone wipe.</li>
<li><strong>Screen Share.</strong> Screen Share (live view and computer use) comes in 0.3.1; Chrome control works today.</li>
<li><strong>Mac server.</strong> The Mac server installer has not run on a real Mac yet.</li>
<li><strong>Home routers.</strong> Home-router NAT is untested: a direct path through a home router has not been tried, and the relay carries the connection when there is none.</li>
<li><strong>Phone notifications.</strong> Notifications when the phone app is closed: only web push today. Native push needs Apple and Google push accounts, which are not set up.</li>
<li><strong>Models.</strong> Only the answer fan-out across models is proven; per-model plan and diff blocks are not.</li>
<li><strong>Chrome.</strong> Parallel tabs read within one Chrome; a tab for each agent is not built.</li>
<li><strong>Scale.</strong> Idle sessions do not sleep under memory pressure yet, and there is no fair-share scheduler.</li>
<li><strong>Windows.</strong> The Windows app is not code-signed, and the first Windows install is not signature-checked.</li>
<li><strong>Sideloaded apps.</strong> The Mac app has no Apple Developer ID signature yet and the Android app is not on a store, so you install both from the file.</li>
<li><strong>npm.</strong> <code>npm install -g vyre</code> works once the package is published. Until then, use the tarball URL.</li>
</ul>
<p>More detail: <a href="https://github.com/vyre-ai/vyre/blob/main/docs/known-gaps.md">Known gaps</a>. Where this is going: <a href="/direction/">Direction</a>.</p>`)}
${part('?', 'trouble', 'If something goes wrong', `<ul>
<li>The app says the reservation code is not valid: it lasts 24 hours and works once. Reserve the name again on vyre.run/setup.</li>\n<li>The app says the line expired, or two servers used it: press <em>Start again</em> for a new line.</li>
<li>The words do not match: press <em>They don’t match</em>, then start again. It means the line was not run on your server.</li>
<li>On the server: <code>vyre status</code>, <code>vyre logs</code>, and <code>docker compose -p vyre ps</code>.</li>
<li>Start over on a Linux server (keeps your data): <code>curl -fsSL https://vyre.run/install.sh | sh -s -- --uninstall</code>, then set up again. Add <code>--purge</code> to delete the vault, sign-ins and projects too.</li></ul>`)}
</div></section>
<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">Ready <b>when you are.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/start/">Read the steps</a><a class="btn" href="https://github.com/vyre-ai/vyre">GitHub</a></div></div></section>`;
page({
  slug: 'start', path: '/start/',
  title: 'Get started with Vyre: reserve your name, install the app, add a server',
  desc: 'The steps in order: reserve your name, install the Mac or Windows app, paste the code, join a team or add a server, check four words, add your phone.',
  ogTitle: 'Start with your name.', ogSub: 'Reserve your name, install the app, join a team or add a server, then add your phone.',
  body: START, ld: [crumbs([['Vyre', `${SITE}/`], ['Get started', `${SITE}/start/`]])],
});

// ---------- privacy ----------
// Every claim here is checked against the code before it ships (platform reads it, then the stores see it). Where a claim depends on a
// build (store push, a cache that moves to disk) the sentence says so. With CONTACT_EMAIL null the page points at GitHub only.
const CONTACT_EMAIL = 'privacy@vyre.run'; // Forwarded to the maintainer by a Cloudflare Email Routing rule on the vyre.run zone ("privacy@ to the maintainer", set 5 Oct 2026, user's decision).
const ul = (items) => `<ul class="plain" style="margin:0 0 4px;padding-left:1.1em">${items.map((x) => `<li style="margin:.45em 0">${x}</li>`).join('')}</ul>`;
const PRIV = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Privacy</p>
    ${eyebrow('Privacy.')}
    <h1 class="display">What Vyre knows <b>about you.</b></h1>
    <p class="lead">Almost nothing. Vyre runs on your own server, and the project behind it keeps no account of you, no copy of your work and no analytics. This page says what the few Vyre services do see, and what each app keeps on your device. Last updated 5 October 2026, for Vyre 0.2.9.</p>
  </div>
</section>
<section class="sec" style="padding-top:24px"><div class="wrap">
${part('01', 'short', 'The short version', ul([
  '<b>Your work stays on your server.</b> Sessions, memory, files, the vault and your conversations live on the server you run and on your own devices. Vyre does not receive them.',
  '<b>No account, no analytics, no ads, no trackers.</b> There is no Vyre sign-up. The apps, the server and this site contain no analytics or crash-reporting code, and none of them sends usage data anywhere. Two optional lookups are listed in section 07.',
  '<b>Three small services run by the project:</b> a relay that carries encrypted traffic, a name directory for <code>yourname.vyre.run</code>, and this website. Below is what each one sees. Releases come from GitHub.',
  '<b>Your personal memory is encrypted with your own key.</b> A server\'s owners and admins cannot read it, and each chat is encrypted to the people in it. Sections 03 and 04 say more.',
  '<b>Your AI providers see your prompts</b>, because that is how an AI works. You sign in to them yourself, with your own accounts and keys.',
]))}
${part('02', 'server', 'Your data stays on your server', `<p>Vyre keeps its data on the machine you installed it on: sessions, memory, project files you chose, the vault, logs and settings. On a Linux server that is a set of Docker volumes; on a Mac that runs Vyre directly it is the <code>~/.vyre</code> folder. The vault is sealed on that machine. Nothing in it is sent to Vyre.</p>
<p>When an agent works, your server sends the prompt to the AI provider you picked (Claude, Codex, Grok or OpenRouter), under your own account, and that provider's terms and privacy policy apply to it. The sign-in for each AI account stays on your server. Anything else you connect, such as GitHub or Google, is likewise your own account under that service's terms. Your devices and your server reach each other through Vyre's own private network, which is built in; where a direct path is not possible, the relay carries the connection (section 05).</p>
<p>Voice is the same: when you talk to your assistant, your server sends the audio to the speech service you chose (Deepgram, OpenAI or ElevenLabs) with your own key. When a reply is spoken, your server sends the text of that reply, at most 2,000 characters, to the speech service you chose.</p>
<p>Where a space lives has a name. Your space on your devices is Personal: it keeps chats and projects on your devices, with an encrypted backup to a team's Cloud. Your space on your own server is My Cloud: it adds Records, flows and Planner, reachable from anywhere. Team spaces run on a server and are tagged Cloud.</p>`)}
${part('03', 'memory', 'Your personal memory and assistant', `<p>Your personal memory and your assistant are encrypted with your own key. They can be stored on a Cloud space's server, and the owners and admins of that server cannot read them.</p>
<p>While your assistant is unlocked, your memory is readable only inside the running program and is never written to disk unencrypted. While your assistant is working on a server you don't own, that server's operator could in principle see what it is working on. To avoid that, run your assistant on your own computer or your own server.</p>
<p>If you set up My Cloud on your own server, your personal memory can move there.</p>`)}
${part('04', 'chats', 'Your chats and their files', `<p>Each chat and its files are encrypted to the people in that chat. A Cloud space's owners and admins cannot read chats they are not in, even with access to the server's disk. File names are encrypted too.</p>
<p>While an agent works in a chat on a server, that server's operator could see that chat in use.</p>`)}
${part('05', 'relay', 'What the relay sees', `<p>The relay at <code>relay.vyre.run</code> lets a phone, a browser or a Windows PC reach your server without a direct path. Your server connects to it when the relay is on, which pairing a device turns on. It carries traffic and nothing else.</p>
${ul([
  '<b>Traffic is encrypted from your device to your server.</b> Each side holds its own key and the relay holds none, so it cannot read a message and any change to one is rejected by the receiver. It can drop or delay a message.',
  '<b>Pairing records are sealed and short-lived.</b> A Wink pairing record is stored as ciphertext for at most 5 minutes, handed out once, and deleted when it is used or when it expires.',
  '<b>Frames waiting for your server</b> are held, still encrypted, until your server picks the connection up or the device disconnects, normally one round trip, at most 64 frames per connection. They are deleted on delivery or when the device leaves.',
  '<b>What it can see:</b> the address a connection comes from, when it connects, how large each message is, the route id (a hash of your server\'s public route key) and that public key. It never sees message contents.',
  '<b>Rate limits</b> count requests per address in a 60 second window, so one client cannot flood it: 30 a minute for device connections, 30 a minute for pairing lookups that find nothing, and 20 a minute for setup posts. The hosted relay\'s code does not write those addresses to its storage or to a log.',
  '<b>No request logs.</b> Cloudflare hosts the relay, and the relay\'s configuration has Cloudflare\'s Worker request logs turned off. The hosted relay\'s code writes no log of who connected; the self-hosted Node relay can log route ids when its operator turns logging on.',
])}
<p>The relay is open source (<code>relay/worker</code> and <code>relay/node</code> in the repository). You can run your own and point your server at it with the relay address setting.</p>`)}
${part('06', 'names', 'Your address on vyre.run', `<p>When you choose a name, the name directory at <code>names.vyre.run</code> creates <code>yourname.vyre.run</code> and points it at your server's public address, but only after an outside check shows the server answers; until then the name is not published and the server is reachable through the relay only. DNS is public, so anyone can look up that name and the address it points to. The certificate for the name is also recorded in public certificate logs, which is how the web works. Choose a name you are happy to have public.</p>
${ul([
  '<b>It stores:</b> the name, the route id of your server (a hash of its public key), when the name was claimed and pointed, the public address in the DNS record, a hash of your recovery code (it sees the code itself only when it creates it for you and when you use it to recover), the last 50 recovery attempts with their time, whether the code was right and the first 8 characters of the route id, up to 20 notices, a pending recovery (the new route and code hash), and signature nonces for a couple of minutes.',
  '<b>It asks for no email and no personal details.</b> Every request that changes or reads your name is signed by your server\'s key, and recovery also needs the recovery code. The availability check is unsigned.',
  '<b>Per-address counters</b> hold the requesting address and limit claims (5 a day) and recovery attempts (20 a day). An hourly sweep drops them once they are about two days old.',
  '<b>Giving a name up</b> deletes it if it was never pointed. A name that was ever live stays reserved: the directory keeps the name, the recovery-code hash, the claim and point times, the notices and the recovery log, with no route and no address, so nobody else can take it over; only the recovery code can move it.',
  '<b>No request logs.</b> Cloudflare hosts the directory, with Worker request logs turned off, as for the relay.',
])}`)}
${part('07', 'site', 'This website, updates and downloads', `${ul([
  'vyre.run has <b>no analytics and no cookies</b>.',
  'The marketing pages load their fonts from Google Fonts, so Google sees a font request with your IP address when you open them. The server behind <code>app.vyre.run</code> sets no cookies and keeps nothing about you or your server; the page keeps your device key, server address and pairing in your browser, as section 08 lists.',
  '<b>Two optional lookups:</b> Vyre Lumen on a Mac fetches exchange rates from <code>open.er-api.com</code> when you type something that reads as money, at most every 12 hours, with none of your words sent. The weather action sends a city name (by default one derived from your time zone) to <code>open-meteo.com</code>. The device sign-in page that your own server serves loads its fonts from Google Fonts.',
  'The pages are served by Cloudflare, which keeps ordinary server logs under its own policy.',
  '<b>Updates:</b> your server checks GitHub\'s releases API for new versions and pulls signed images from <code>ghcr.io</code>; the Windows app checks GitHub\'s releases feed once a day and downloads its installer from GitHub; the install line fetches from <code>vyre.run</code>. Those services see the address your server or PC connects from, under their own policies. Vyre itself receives no report of which version you run.',
])}`)}
${part('08', 'apps', 'What each app keeps on your device', `${ul([
  '<b>The Vyre app in a browser or on a Home Screen</b> keeps in the browser\'s own storage: a device key the browser cannot export, the key that opens your private chats and notes, the pairing with your server, a cache of recent views (needs rows, the chat list and snippets), your pins, unsent drafts, recent searches, your appearance settings, where setup stopped, an outbox of writes not yet delivered, and cached app files. The browser\'s push service holds your push subscription, and the app sends it to your server. The web app keeps no unlock session: the browser asks for your passkey on each protected call. On a phone, keys and the pairing sit in the phone\'s secure store, and an unlock session lasts 30 minutes after you confirm. When the owner removes a device, it forgets all of this the next time it reaches Vyre and asks to be paired again; a device that is offline keeps it until then. Two more limits: an old browser that cannot list its databases has only the app\'s four named databases deleted, and a sign-in cookie that your server sets (when the app is opened at your server\'s own address) belongs to the server, which refuses a removed device anyway.',
  '<b>The hosted web app at app.vyre.run</b> keeps two keys the browser cannot export, the pairing record in localStorage, the relay key in IndexedDB and cached app files. It has no wipe: sign out and clear the site\'s data in your browser.',
  '<b>The phone app (iPhone and Android)</b> makes two keys in secure hardware where the phone has it, the Secure Enclave on iPhone and the Android Keystore on Android (some phones fall back to software). One signs its requests, and the other signs only after your face or fingerprint. They cannot be exported. Your sign-in tokens and the pairing with your server are kept in the system Keychain or Keystore. On iPhone those items are marked this-device-only; on Android, backup follows Android\'s own backup rules. The view of recent threads and lists is held in memory and is gone when you close the app. Signing in on your own address opens the system sign-in browser. Pairing links open the app. The app declares no camera, microphone, location, contacts or photos permission, and this version has no notifications.',
  '<b>Vyre Lumen on a Mac</b> keeps its approval key in the Secure Enclave where the Mac has one, with only an opaque handle in the login keychain; a Mac without one keeps a software key in the login keychain. It talks to your server.',
  '<b>Vyre Lumen on Windows</b> (the app is named Vyre in Windows) keeps your server\'s address in a pairing file and its device key in its app data folder, with the key protected by Windows DPAPI. The installer for a newer version is saved there before it runs. Starting at sign-in uses a Windows scheduled task named Vyre, which the app creates and deletes when you change that setting.',
  '<b>Password AutoFill</b> (in the Android phone app, and on iPhone and Mac in builds that include the extension) asks your server for one login at a time, after you confirm with your face or fingerprint. On iPhone and Mac it keeps the server address and a device token in the Keychain and the unlocked session in memory only, and gives the system the sites, usernames, passkey names and one-time-code labels from your vault, never passwords, passkey private keys or code seeds. On Android the address and token sit in Keystore-protected storage, and it uses its own biometric key.',
  '<b>The vault browser extension</b> keeps the address of your server, this browser\'s device id and token, and its two on and off choices in the extension\'s storage, and the unlocked session in session storage. It talks only to the server address you set and sends no page content. With the API-key offer on, it reads the page text on your device looking for one key-shaped value, and a matched value leaves the page only after you tap Save.',
])}`)}
${part('09', 'camera', 'Camera and microphone', `<p>The camera is used for one thing: scanning a Wink, the code that pairs or introduces a device, in the Vyre app in a browser or on a phone. It asks for video only, never audio. The picture is read on your device. It is not saved and not sent anywhere. You can also scan a pairing QR code with the phone\'s own camera and it opens the app.</p>
<p>The microphone is used by push-to-talk in Vyre Lumen on a Mac, only while you hold the key or button. The audio goes to your server and from there to the speech service you chose; your server does not log or keep it. The phone app declares no microphone permission (the browser app never asks for audio), and the Windows app has no microphone code.</p>`)}
${part('10', 'passkeys', 'Passkeys and keys', `<p>You make your passkey for your own server's address, with your device's own passkey system. The private key stays in your device's secure hardware or your password manager. Your server keeps only the public half, and Vyre never receives either. The approval key in the phone app is made in secure hardware where the phone has it (the Secure Enclave or the Android Keystore; some phones fall back to software), cannot be exported, and needs your face or fingerprint to use. Your identity has its own recovery code. It is shown to you once; keep it somewhere safe. It restores your identity on a new device.</p>`)}
${part('11', 'push', 'Notifications', `<p>A notification carries a fixed sentence, such as "A session is waiting for your answer", "A milestone is done" or "A teammate finished", and a link to an item by its id. That is all. It carries no thread text, no goal or milestone text, no message text, no teammate name and no project name. The phone opens the item and asks your own server for the details, over your own connection. The fixed sentence does say what kind of thing happened: a question, an approval or a finished goal.</p>
<p>One setting is an exception, and it is off by default: <em>Show a reminder\'s own words on the lock screen</em>. When you turn it on, the label you typed on a reminder rides in that notification and passes through Apple\'s, Google\'s or Mozilla\'s push service. The setting says so.</p>
<p>Notifications work today through Web Push in a browser or on a Home Screen web app. Web Push encrypts the payload end to end and delivers it through your browser\'s push service (Google, Mozilla, Apple or Microsoft), which still sees that a notification was sent to a device, and when. The phone app has no notifications in this version.</p>`)}
${part('12', 'crash', 'Crash logs and diagnostics', `<p>Vyre sends no crash reports and no diagnostics anywhere. Your server writes a log file for each day on your own machine, and <code>vyre doctor</code> prints its checks to your own screen. If something breaks, you decide whether to share a log, for example in a GitHub issue. Your phone's operating system may send its own crash reports to Apple or Google if you turned that on in system settings; that is theirs, not Vyre's.</p>`)}
${part('13', 'delete', 'Delete everything', `${ul([
  '<b>On your server:</b> If you want a copy of your data, run <code>vyre backup</code> and copy the file off the server, because it is saved inside the volume the uninstall deletes. Then run <code>vyre uninstall --delete-data</code>, which stops Vyre, removes its images and deletes its data volumes for good. Finally remove the install folder (<code>/srv/vyre</code>, or your <code>VYRE_DIR</code>; the uninstall prints it) and <code>/var/lib/vyre-update</code>, where automatic updates keep their backups.',
  '<b>On a Mac that runs Vyre as a server,</b> run the installer\'s <code>--uninstall --purge</code> (<code>scripts/install-mac-server.sh</code>), which removes the service, <code>~/.vyre-server</code>, <code>~/.vyre</code> and the system data. Delete <code>~/Vyre/projects</code> if you used it, and remove the <code>vyre-vault</code> and <code>sh.vyre.capsule.presence</code> items in Keychain Access.',
  '<b>On a phone:</b> remove it in Devices on your server first, so its keys stop working. Signing out in the phone app ends your session when the phone can reach your server and forgets the sign-in on the phone, but the phone stays paired. Deleting the app removes its keys on Android; on iPhone the system may keep them.',
  '<b>On a Mac with Vyre Lumen:</b> Lumen lives in <code>~/.vyre/capsule/Vyre.app</code>, so it goes with <code>~/.vyre</code>, but its Keychain item stays: remove <code>sh.vyre.capsule.presence</code> in Keychain Access. <b>On Windows:</b> uninstall Vyre in Windows Settings, delete the <code>run.vyre.app</code> folder in <code>%APPDATA%</code> (the pairing file and key), and delete the scheduled task named Vyre in Task Scheduler, or turn off start at sign-in before you uninstall.',
  '<b>What stays with the project:</b> nothing of your work, because it never arrived. Relay records expire within an hour, held frames go when delivered or when the device leaves, and address counters go within about two days. A name that was ever live stays reserved, as described above. To have even that looked at, write to the contact below.',
])}`)}
${part('14', 'contact', 'Contact', `<p>Questions about this page, or a request about a name: ${CONTACT_EMAIL ? `email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>, or ` : ''}open an issue at <a href="https://github.com/vyre-ai/vyre/issues">github.com/vyre-ai/vyre/issues</a>. A security problem goes to a private advisory at <a href="https://github.com/vyre-ai/vyre/security/advisories/new">github.com/vyre-ai/vyre/security</a>, not a public issue.</p>
<p>Vyre is open source (Apache 2.0). Every claim on this page can be checked in the code, and changes to this page are in its history on GitHub.</p>`)}
</div></section>`;
page({
  slug: 'privacy', path: '/privacy/',
  title: 'Privacy: what Vyre knows about you',
  desc: 'Your data stays on your own server. What the relay and the name directory see, what each Vyre app keeps on your device, camera and microphone use, passkeys, notifications, and crash logs.',
  ogTitle: 'What Vyre knows about you.', ogSub: 'Almost nothing. Your data stays on your server, and no one is counting.',
  body: PRIV, ld: [crumbs([['Vyre', `${SITE}/`], ['Privacy', `${SITE}/privacy/`]])],
});

// ---------- 404 ----------
{
  const html404 = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found: Vyre</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta name="color-scheme" content="light dark">
<link rel="preload" as="style" href="${FONTS}" onload="this.onload=null;this.rel='stylesheet'"><link rel="stylesheet" href="${CSS_V}"><script src="${JS_V}" defer></script></head>
<body>${nav('404')}<main id="main" class="nf"><div class="wrap"><p class="lbl">404</p><h1 class="display">That page <b>is not here.</b></h1><p class="lead" style="margin-inline:auto">It may have moved. Start from the home page, or set up Vyre.</p><div class="btn-row" style="justify-content:center"><a class="btn btn-fill" href="/">Home</a><a class="btn" href="/start/">Set up Vyre</a></div></div></main>${FOOT}</body></html>
`;
  writeFileSync(join(site, '404.html'), html404);
}

// ---------- machine-readable files ----------
const list2 = (arr) => arr.map((x) => `- ${x}`).join('\n');
const SUMMARY = 'Vyre is an open-source (Apache 2.0) command center for AI agents that runs on machines you own. One session works across Claude, Codex, Grok and OpenRouter, using your own subscriptions or keys. Agents run on a Linux server (or a Mac that stays on) and keep working when your laptop is closed. You reach them from Vyre Lumen on a Mac (Option-Space), Vyre Lumen on Windows (Alt+Space), and a phone web app paired with Face ID.';

const LLMS = `# Vyre

> ${SUMMARY}

Current release: ${VERSION}. Site: ${SITE}. Source: https://github.com/vyre-ai/vyre. Licence: Apache 2.0. Vyre is free; you pay your AI providers directly.

## Start here
- [Home](${SITE}/): what Vyre is and what it does
- [Get started](${SITE}/start/): the steps, from the Vyre app to pairing your server
- [Get started](${SITE}/start/): the steps in order
- [Direction](${SITE}/direction/): where Vyre is going (direction, not a promise of dates)
- [Privacy](${SITE}/privacy/): what Vyre knows about you, which is almost nothing

## Devices
- [Mac: Vyre Lumen](${SITE}/mac/): Option-Space ask window, built on your Mac
- [Windows: Vyre Lumen](${SITE}/windows/): tray app with an Alt+Space panel
- [Linux server](${SITE}/linux/): where Vyre runs
- [Phone](${SITE}/phone/): the Vyre app, sideloaded on Android (APK) or iPhone (Xcode)

## Machine-readable
- [llms-full.txt](${SITE}/llms-full.txt): the same content in full
- [agents.md](${SITE}/agents.md): guidance for AI agents that install or operate Vyre
- [sitemap.xml](${SITE}/sitemap.xml)
- [GitHub](https://github.com/vyre-ai/vyre)
`;

const FULL = `# Vyre, in full

${SUMMARY}

Release ${VERSION}. Updated ${MODIFIED}. Source: https://github.com/vyre-ai/vyre. Licence: Apache 2.0.

## What it is
- One session runs Claude, Codex, Grok or OpenRouter. Each reply shows which model wrote it. You can switch model mid-session (the new model gets a summary of the conversation) or address one model for a single message with an @, such as @codex.
- Several accounts per provider are supported and kept apart on the server.
- Teammates are named roles inside a project with their own notes and a charter; they hand work to each other. A person can fill a role with one of their own agents.
- Watchers run on events, schedules or Gmail pushes. Each is shown as a card (when, check, do, what it reads, whether it acts, cost) before it is turned on. Watchers run inside a wall with no home folder and no sockets; where the wall is unavailable a watcher does not run and says why.
- Memory records every session. A recalled answer shows its source (the call, thread or turn) and says when no model was used. Corrections and Forget are supported, with undo.
- The vault holds credentials sealed on your own machine. Agents use a credential without seeing its value. A Mac unlocks it with Touch ID or a password.
- "Asking is approving": your own words approve an action. Touch ID or Face ID is for pairing, vault secrets, and sends, posts or payments nobody asked for.
- Vyre for Chrome lets an agent drive your own Chrome. Agent computers, GitHub, generated images and video saved to the project, and a daily spend cap are included.
- Modules are the building blocks you or your agents add. Each declares who may call each tool.

## Where it runs
- Server: Linux with Docker Compose 2.24 or newer, or a Mac that stays on. Installed in /srv/vyre by one line, curl -fsSL vyre.run/i | sh, which the Vyre app shows. Images are pulled by digest after their signatures are checked. Updates are signed with a pinned key; a box refuses unsigned, tampered or older releases. Stable never takes a prerelease.
- Mac: Vyre Lumen, opened with Option-Space (or Control twice). Built on your Mac by \`vyre capsule install\`; self-signed, not notarized. Needs Node 22.5 or newer.
- Windows: Vyre Lumen, a tray app with an Alt+Space panel, installed with VyreSetup.exe from the GitHub release. Not Authenticode-signed yet, so Windows asks for "More info", then "Run anyway". Pairs with 13 words or a QR code. The server does not run on Windows yet.
- Phone: the Vyre app, sideloaded (the Android APK from the release, or an iPhone build installed with Xcode), paired by scanning a code, with Face ID or a fingerprint. A removed phone wipes itself.
- Network: built in. Nothing to install or sign in to; the relay carries a connection when a direct path is not possible.

## Install
1. Reserve your name at ${SITE}/setup/ and copy the code it shows.
2. Install the app from https://github.com/vyre-ai/vyre/releases/latest: Vyre-Lumen-aarch64.dmg or Vyre-Lumen-x86_64.dmg on a Mac, VyreSetup.exe on Windows. Both are sideloaded (not signed with a store identity yet).
3. Open the app, paste the code and save the recovery code.
4. Choose Join a team, Add a server (a Linux machine, or a Mac that stays on; With Records is recommended) or, on a Mac, Use My Home.
5. To add a server, run the one line the app shows on it, as yourself: \`curl -fsSL https://vyre.run/i | VYRE_CODE=<code from the app> sh\`. Confirm the four words in the app.
6. Add your phone from the app: Vyre-android.apk from the release on Android (sideloaded); iPhone has no App Store app yet.

## What it costs
Vyre is free and open source. You pay your AI providers (Claude, Codex, Grok, OpenRouter) on your own subscriptions or keys. Your data lives on your devices and on servers you or your team run. Vyre doesn't hold it. A Cloud space is a server you or your team chose, not ours. A Vyre-hosted home for people without a server may come later, and it would be optional.

## Where your data lives
Sessions, memory and the vault stay on your machines. vyre.run holds your name's DNS record and runs the relay (relay.vyre.run), which carries phone pairing, end-to-end encrypted. Prompts go to your AI provider the way they would from that provider's own app.

## Releases
${RELEASE_LINE ? '- ' + RELEASE_LINE : ''}

## Direction (not a promise of dates)
- Now, 0.2.9: Spaces (Personal on your devices, My Cloud on your own server, and Cloud spaces for teams). Records (contacts, projects, tasks and anything you define, with flows and watchers to run them). Chats (one place for you, your team and every AI model, with each chat encrypted to the people in it). A built-in network (pair a device with one typed code, with no VPN to install). Lend a computer to a team; your work on it is encrypted at rest on your computer and on the server, and deleted from your computer when access ends.
- Next, 0.3.1: Screen Share. Watch and take over your agents' computers and Chrome, on every device.
- Later: a Vyre-hosted home for people without a server.

## Known gaps in ${VERSION}
- Nothing has been walked on a real iPhone or Android yet, including Face ID pairing and the removed-phone wipe.
- Screen Share (live view and computer use) comes in 0.3.1; Chrome control works today.
- The Mac server installer has not run on a real Mac yet.
- Home-router NAT is untested: a direct path through a home router has not been tried, and the relay carries the connection when there is none.
- Notifications when the phone app is closed: only web push today. Native push needs Apple and Google push accounts, which are not set up.
- Only the answer fan-out across models is proven; per-model plan and diff blocks are not.
- Parallel Chrome tabs read within one Chrome; a tab for each agent is not built.
- Idle sessions do not sleep under memory pressure yet, and there is no fair-share scheduler.
- The Mac app is built on your Mac, not downloaded. The Windows app is not code-signed yet, and the first Windows install is not signature-checked.
See https://github.com/vyre-ai/vyre/blob/main/docs/known-gaps.md.

## FAQ
${HOME_FAQ.map(([q, a]) => `### ${q}\n${strip(a)}`).join('\n\n')}
`;

const AGENTS = `# agents.md: for AI agents that read vyre.run

Vyre is an open-source command center for AI agents, run on machines the user owns. This file says what you can do with this site and what you must not do.

## What you can do
- Read any page and the machine-readable files: ${SITE}/llms.txt, ${SITE}/llms-full.txt, ${SITE}/sitemap.xml.
- Tell the user how to install: send them to ${SITE}/start/. The Vyre app shows the user one install line. The user runs it on their own server.
- Answer questions about devices (${SITE}/mac/, ${SITE}/windows/, ${SITE}/linux/, ${SITE}/phone/) and direction (${SITE}/direction/). Direction is not a promise of dates.
- Read the source at https://github.com/vyre-ai/vyre. It is Apache 2.0.

## What you must not do
- Do not run the install line, or anything with a pairing code in it, for the user. The code belongs to the user, works once, and is entered in their Vyre app.
- Do not ask the user to paste secrets, vault values, recovery codes or setup codes into a chat.
- Do not claim Vyre runs a server on Windows, or that a Mac download exists. Check ${SITE}/llms-full.txt for the current gaps.

## Facts to repeat exactly
- Apache 2.0. Free. The user pays their own AI providers.
- Server: Linux with Docker Compose 2.24 or newer, or a Mac that stays on. One space per server. A 4 GB server runs one space; Vyre sizes it for you. 8 GB is comfortable and leaves room to grow.
- Mac app: Vyre Lumen, Option-Space. Windows app: Vyre Lumen, Alt+Space. Phone: the Vyre app, sideloaded.
- Current release: ${VERSION}.

## Operating a user's own Vyre
Once installed, a Vyre box has its own tools, permissions and an approval floor. Your own words as an agent are never an approval: only the person's words are. Read the Vyre documentation in the repository before acting on a user's box.
`;

const AGENT_JSON = {
  schema_version: '1',
  name: 'Vyre',
  description: SUMMARY,
  url: `${SITE}/`,
  version: VERSION,
  license: 'Apache-2.0',
  docs: { llms: `${SITE}/llms.txt`, llms_full: `${SITE}/llms-full.txt`, agents: `${SITE}/agents.md`, source: 'https://github.com/vyre-ai/vyre' },
  install: { url: `${SITE}/start/`, note: 'The Vyre app shows the user the install line and pairs the server with a code and three words. An agent must not run the install line for the user.' },
  platforms: { server: ['Linux', 'macOS (a Mac that stays on)'], clients: ['macOS (Vyre Lumen)', 'Windows (Vyre Lumen)', 'iOS and Android (the app, sideloaded)'] },
};

const write = (p, s) => { mkdirSync(dirname(join(site, p)), { recursive: true }); writeFileSync(join(site, p), s); };
write('llms.txt', LLMS);
write('llms-full.txt', FULL);
write('agents.md', AGENTS);
write('.well-known/agent.json', JSON.stringify(AGENT_JSON, null, 2) + '\n');
write('robots.txt', `# Everyone, including AI crawlers and assistants, is welcome to read this site.
User-agent: *
Allow: /
Disallow: /setup/

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

Sitemap: ${SITE}/sitemap.xml
`);
const SM = [['/', '1.0'], ['/mac/', '0.8'], ['/windows/', '0.8'], ['/linux/', '0.8'], ['/phone/', '0.8'], ['/direction/', '0.7'], ['/start/', '0.7'], ['/privacy/', '0.5']];
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SM.map(([p, pr]) => `  <url>\n    <loc>${SITE}${p}</loc>\n    <lastmod>${MODIFIED}</lastmod>\n    <priority>${pr}</priority>\n  </url>`).join('\n')}
</urlset>
`);

// ---------- og cards ----------
if (ogDir) {
  mkdirSync(ogDir, { recursive: true });
  for (const p of pages) {
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap"><style>
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:#0E0D0C;color:#F1EEE6;font-family:'Instrument Sans','Helvetica Neue',Arial,sans-serif;position:relative;overflow:hidden}
.l{position:absolute;left:72px;top:64px;right:520px;bottom:64px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:12px;color:#F1EEE6}
.lbl{margin-top:auto;font:500 16px 'JetBrains Mono',monospace;letter-spacing:.1em;text-transform:uppercase;color:#8C877D}
h1{font-weight:600;font-size:${p.ogTitle.length > 40 ? 56 : 68}px;line-height:1.04;letter-spacing:-.035em;margin:18px 0 18px}
p{font-size:25px;line-height:1.4;color:#B3AEA4;margin:0;max-width:600px}
canvas{position:absolute;right:40px;top:75px;width:480px;height:480px}
.bar{position:absolute;left:0;right:0;bottom:0;height:8px;background:#B8A4FF}
</style><body><div class="l"><div class="brand"><svg width="34" height="34" viewBox="0 0 24 24" fill="none"><path d="M3.5 5.5L12 19.5L17.96 9.69" stroke="#F1EEE6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20.5" cy="5.5" r="2.3" fill="#F1EEE6"/></svg><svg width="80" height="34" viewBox="-2 3 62 26" fill="none"><path d="M0 6L6 20L12 6M16 6L22 20M28 6L19.4 26M33 6V20M33 13Q33 6 40 6M43 13H57A7 7 0 1 0 55.36 17.5" stroke="#F1EEE6" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<div class="lbl">vyre.run${p.path === '/' ? '' : p.path.replace(/\/$/, '')}</div><h1>${esc(p.ogTitle)}</h1><p>${esc(p.ogSub)}</p></div><canvas class="markart" data-accent="on"></canvas><div class="bar"></div>
<script src="file://${join(site, 'v2.js')}"></script></body>`;
    writeFileSync(join(ogDir, `${p.slug}.html`), html);
  }
}
console.log(`gen-site: ${pages.length} pages, version ${VERSION}`);
