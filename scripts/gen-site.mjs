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
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '..', 'site');
const SITE = 'https://vyre.run';
// The release the site speaks for. scripts/assemble-site.sh --tag vX.Y.Z passes it as VYRE_SITE_VERSION, so a release updates every page by itself;
// the default is the newest release this file knows the notes for (RELEASE_NOTES below).
const VERSION = process.env.VYRE_SITE_VERSION && /^\d+\.\d+\.\d+$/.test(process.env.VYRE_SITE_VERSION) ? process.env.VYRE_SITE_VERSION : '0.5.0';
// What each release fixed, in the words the home page and llms-full.txt use. A version with no entry here shows no "out now" line.
const RELEASE_NOTES = {
  '0.2.1': 'Claude sign-in accepts the pasted code, and the phone app installs properly from the home screen.',
  '0.2.9': 'the first release of the 0.3 work: Spaces, Wink, the objects layer and the one-yes approvals.',
  '0.5.0': 'people and agents in the same chats, Flows, Playbooks, Records, a Vault for people and agents, Sites, Documents and Signing.',
  '0.2.2': 'Your own phone, Deck and Mac stop locking each other out of a conversation, a session on a server always gets Vyre\u2019s tools, a provider\u2019s only account is its default, and a message you send shows Sending until the server answers.',
};
const RELEASE_LINE = RELEASE_NOTES[VERSION] ? `${VERSION} (out now): ${RELEASE_NOTES[VERSION]}` : '';
const MODIFIED = new Date().toISOString().slice(0, 10);
// A hash of each asset goes in its URL, so a deploy never meets a stale copy in a browser cache (see site/_headers).
const hash = (f) => createHash('sha256').update(readFileSync(join(site, f))).digest('hex').slice(0, 10);
const CSS_V = `/v2.css?v=${hash('v2.css')}`, JS_V = `/v2.js?v=${hash('v2.js')}`;
// The two faces are vyre.run's own files (site/fonts, the same as web/fonts): the first page someone opens does not call another company.
const FONT_PRELOAD = '<link rel="preload" as="font" type="font/woff2" href="/fonts/instrument-sans-latin.woff2" crossorigin>';
// The Vyre mark, the app's own icon: a card with a folded corner, the V in cream halftone dots and the violet bead. It is site/favicon.svg itself,
// inlined as vector so it is crisp at any size; ids are made unique per use. The bead is the only violet in it.
const FAVICON = readFileSync(join(site, 'favicon.svg'), 'utf8');
const vmark = (id, cls = '', attrs = '') => FAVICON.replace(/ width="64" height="64"/, ` class="vmark ${cls}" ${attrs} aria-hidden="true" focusable="false"`).replace(/id="(card|flap|shade)"/g, `id="$1-${id}"`).replace(/url\(#(card|flap|shade)\)/g, `url(#$1-${id})`);
const ogDir = process.argv.includes('--og') ? resolve(process.argv[process.argv.indexOf('--og') + 1]) : null;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- shared marks and icons ----------
const MARK = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 5.5L12 19.5L17.96 9.69" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20.5" cy="5.5" r="2.3" fill="currentColor"/></svg>`;
const WORD = `<svg width="52" height="22" viewBox="-2 3 62 26" fill="none" aria-hidden="true"><path d="M0 6L6 20L12 6M16 6L22 20M28 6L19.4 26M33 6V20M33 13Q33 6 40 6M43 13H57A7 7 0 1 0 55.36 17.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ic = (d, w = 28) => `<svg class="ic" width="${w}" height="${w}" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
// ---------- device frames and real app clips ----------
// Every screen on the site is a recording of the app itself (site/media, from the app's preview build with sample data), one clip per theme.
// The frames are drawn in CSS (v2.css: .mbp, .ip, .appwin). A visitor who asks for less motion gets the still poster.
const clip = (name, w, h) => ['dark', 'light'].map((t) => `<picture class="th-${t}"><source media="(prefers-reduced-motion: reduce)" srcset="/media/${name}-${t}.png"><img src="/media/${name}-${t}.webp" width="${w}" height="${h}" alt="" loading="lazy" decoding="async"></picture>`).join('');
const BARS = '<svg viewBox="0 0 64 12" aria-hidden="true"><g fill="currentColor"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></g><path d="M27 4.2a8 8 0 0 1 11 0M29.2 6.9a4.8 4.8 0 0 1 6.6 0M32.5 9.6l.01 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><g><rect x="43" y=".8" width="19" height="10.4" rx="3" fill="none" stroke="currentColor" opacity=".5"/><rect x="44.6" y="2.4" width="13.5" height="7.2" rx="1.6" fill="currentColor"/><rect x="62.6" y="4" width="1.4" height="4" rx=".7" fill="currentColor" opacity=".5"/></g></svg>';
const laptop = (name, label) => `<figure class="mbp" role="img" aria-label="${esc(label)} Sample data."><div class="mbp-lid"><div class="mbp-bezel"><div class="mbp-screen"><div class="mbp-menubar" aria-hidden="true"><span><b>Vyre</b><i>File</i><i>Edit</i><i>View</i><i>Window</i></span><span>Wed 9:41</span></div><i class="mbp-notch" aria-hidden="true"></i><div class="mbp-app">${clip(name, 1440, 900)}</div></div></div></div><div class="mbp-deck" aria-hidden="true"><i class="mbp-keys"></i><i class="mbp-keys k2"></i></div><div class="mbp-lip" aria-hidden="true"><i></i></div></figure>`;
const phoneFrame = (name, label, style = '') => `<figure class="ip"${style ? ` style="${style}"` : ''} role="img" aria-label="${esc(label)} Sample data."><i class="ip-btn a" aria-hidden="true"></i><i class="ip-btn u" aria-hidden="true"></i><i class="ip-btn d" aria-hidden="true"></i><i class="ip-btn p" aria-hidden="true"></i><div class="ip-body"><div class="ip-glass"><div class="ip-status" aria-hidden="true"><span>9:41</span><span class="ip-sig">${BARS}</span></div><i class="ip-island" aria-hidden="true"></i><div class="ip-app">${clip(name, 390, 844)}</div></div></div></figure>`;
const appwin = (name, label) => `<figure class="appwin" role="img" aria-label="${esc(label)} Sample data."><div class="appwin-bar" aria-hidden="true"><span>Vyre</span><span class="cap"><i>&#8211;</i><i>&#9633;</i><i>&#215;</i></span></div><div class="appwin-app">${clip(name, 1440, 900)}</div></figure>`;

const I = {
  mac: ic('<rect x="3.5" y="5" width="21" height="14" rx="2"/><path d="M10 23h8M14 19v4"/>'),
  win: ic('<path d="M4 6.5l8.5-1.2v8.2H4zM14 5l10-1.4v9.9H14zM4 15h8.5v8.2L4 22zM14 15h10v9.4L14 23z"/>'),
  server: ic('<rect x="4" y="5" width="20" height="7" rx="1.6"/><rect x="4" y="16" width="20" height="7" rx="1.6"/><path d="M8 8.5h.01M8 19.5h.01M13 8.5h8M13 19.5h8"/>'),
  phone: ic('<rect x="8" y="3.5" width="12" height="21" rx="2.6"/><path d="M12.5 21h3"/>'),
  ai: ic('<circle cx="14" cy="14" r="9.5"/><path d="M14 8v6l4 2.4"/>'),
  agents: ic('<circle cx="9" cy="10" r="3.2"/><circle cx="19" cy="10" r="3.2"/><path d="M3.5 22c.6-3.6 2.8-5.4 5.5-5.4s4.9 1.8 5.5 5.4M13.5 22c.6-3.6 2.8-5.4 5.5-5.4s4.9 1.8 5.5 5.4"/>'),
  modules: ic('<rect x="4" y="12" width="9" height="9" rx="1.4"/><rect x="15" y="12" width="9" height="9" rx="1.4"/><rect x="9.5" y="4" width="9" height="9" rx="1.4"/><path d="M12 4v-.01M17 4v-.01"/>'),
  records: ic('<rect x="4" y="5" width="20" height="18" rx="1.8"/><path d="M4 11h20M4 17h20M11 5v18"/>'),
  flows: ic('<circle cx="7" cy="8" r="2.6"/><circle cx="21" cy="8" r="2.6"/><circle cx="14" cy="21" r="2.6"/><path d="M9.6 8h8.8M8.4 10.3l4.2 8.4M19.6 10.3l-4.2 8.4"/>'),
  chat: ic('<path d="M5 6.5h18v11.5H13.5L9 22.5V18H5z"/><path d="M10 11h8M10 14.5h5"/>'),
  stages: ic('<rect x="3.5" y="8" width="6" height="12" rx="1.2"/><rect x="11" y="8" width="6" height="12" rx="1.2"/><rect x="18.5" y="8" width="6" height="12" rx="1.2"/><path d="M6.5 12.5h.01M14 12.5h.01M21.5 12.5h.01"/>'),
  vault: ic('<rect x="5" y="12" width="18" height="11" rx="2"/><path d="M9 12V9a5 5 0 0 1 10 0v3M14 16.5v3"/>'),
  sites: ic('<circle cx="14" cy="14" r="9.5"/><path d="M4.5 14h19M14 4.5c3 3 3 16 0 19M14 4.5c-3 3-3 16 0 19"/>'),
  doc: ic('<path d="M7 3.5h10l5 5v16H7z"/><path d="M17 3.5v5h5M10.5 13h8M10.5 17h8M10.5 21h4"/>'),
  sign: ic('<path d="M4 22.5c3-6 5-9 6.5-9s.5 4 2.5 4 3-3 5-3 2 2 5 2"/><path d="M4 25h20"/>'),
  people: ic('<circle cx="14" cy="9.5" r="4"/><path d="M5.5 23c.8-4.6 4-7 8.5-7s7.7 2.4 8.5 7"/>'),
};
const STAR = `<svg class="star-ic" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>`;
const REPO = 'https://github.com/vyre-ai/vyre';
const APP_URL = 'https://web.vyre.run';
const DL = `${REPO}/releases/latest/download`;
const MAP_URL = `${REPO}/blob/main/docs/for-agents/MAP-YOUR-BUSINESS.md`;

// ---------- layout ----------
const NAV = [
  ['Product', '/#product'],
  ['Downloads', '/downloads/'],
  ['Architecture', '/architecture/'],
  ['Direction', '/direction/'],
  ['Open source', '/#open'],
];
function nav(slug) {
  const links = NAV.map(([t, h]) => {
    const cur = ((slug === 'direction' && h === '/direction/') || (slug === 'architecture' && h === '/architecture/') || (slug === 'downloads' && h === '/downloads/')) ? ' aria-current="page"' : '';
    return `<a href="${h}"${cur}>${t}</a>`;
  }).join('') + `<a class="only-m" href="${APP_URL}">Log in</a><a class="only-m" href="/start/">Set up Vyre</a>`;
  return `<a class="skip" href="#main">Skip to content</a>
<header class="nav">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Vyre, home">${MARK}${WORD}</a>
    <nav class="nav-links" id="links" aria-label="Main">${links}</nav>
    <div class="nav-end">
      <a class="star-pill" href="${REPO}" aria-label="Star Vyre on GitHub">${STAR}<span>Star</span></a>
      <button class="icon-btn" id="theme" type="button" aria-label="Switch theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor"/></svg></button>
      <a class="btn btn-sm nav-login" href="${APP_URL}">Log in</a>
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
        <p class="tag">The agentic command center for AI-native teams. Open source, Apache 2.0.</p>
      </div>
      <div><p class="fh">Devices</p><ul><li><a href="/downloads/">Downloads</a></li><li><a href="/mac/">Mac</a></li><li><a href="/windows/">Windows</a></li><li><a href="/linux/">Linux server</a></li><li><a href="/phone/">Phone</a></li></ul></div>
      <div><p class="fh">Learn</p><ul><li><a href="/architecture/">Architecture</a></li><li><a href="/direction/">Direction</a></li><li><a href="/start/">Get started</a></li><li><a href="/privacy/">Privacy</a></li><li><a href="https://github.com/vyre-ai/vyre/blob/main/docs/known-gaps.md">Known gaps</a></li></ul></div>
      <div><p class="fh">Open source</p><ul><li><a href="https://github.com/vyre-ai/vyre">GitHub</a></li><li><a class="star-link" href="https://github.com/vyre-ai/vyre">${STAR}Star on GitHub</a></li><li><a href="https://github.com/vyre-ai/vyre/releases">Releases</a></li><li><a href="https://github.com/vyre-ai/vyre/blob/main/LICENSE">License</a></li><li><a href="https://github.com/vyre-ai/vyre#readme">Docs</a></li></ul></div>
      <div><p class="fh">For machines</p><ul><li><a href="/llms.txt">llms.txt</a></li><li><a href="/llms-full.txt">llms-full.txt</a></li><li><a href="/agents.md">agents.md</a></li><li><a href="/sitemap.xml">Sitemap</a></li></ul></div>
    </div>
    <div class="foot-base"><span>Vyre ${VERSION} &middot; Apache 2.0</span><span>No trackers. No cookies. One stylesheet, one script.</span></div>
  </div>
</footer>`;

const ORG = { '@type': 'Organization', '@id': `${SITE}/#org`, name: 'Vyre', url: `${SITE}/`, logo: `${SITE}/icon-512.png`, sameAs: ['https://github.com/vyre-ai'] };
const SOFT = (extra = {}) => ({
  '@type': 'SoftwareApplication', '@id': `${SITE}/#app`, name: 'Vyre', url: `${SITE}/`,
  description: 'Open-source, self-hosted command center where people and AI agents share chats, records, Flows, a vault, sites and documents. One group chat across Claude, Codex, Grok and OpenRouter. Reach it from a Mac, a Windows PC, a Linux server or any phone.',
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
  ${FONT_PRELOAD}
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
  ['Where does my data live?', 'Records, chats, files and the vault stay on your server and your computers. vyre.run holds your name’s DNS record and runs the relay, which carries phone pairing, end-to-end encrypted. Prompts go to your AI provider the way they would from that provider’s own app.'],
  ['Do I need a VPN or another network app?', 'No. Vyre has its own private network built in, so your server, your computers and your phone find each other with nothing to install and nothing to sign in to. Where a direct path is not possible, Vyre’s relay carries the connection, end-to-end encrypted.'],
  ['Does it replace Claude Code, Codex or Grok?', 'No. Vyre runs them with your own accounts and adds records, Flows, a vault, agents with roles and one chat that outlives any one model. You keep using each tool the way you do.'],
  ['What stops an agent from doing something I did not ask for?', 'Anything that leaves your server, such as an email, a payment, a deletion or a published page, waits at the Gate until a person has read the exact words and approved them. An agent can ask and cannot approve. A model sees a placeholder where a secret would be. The <a href="/architecture/">architecture page</a> shows how.'],
  ['Who is Vyre for?', 'Professional services teams that want people and agents to work in one place: the people set the direction and make the calls, and the agents draft, track and follow up. <a href="'+MAP_URL+'">Point your AI agent at the repo</a> and it can show how your business would run on Vyre.'],
  ['Is it ready?', `It is ${VERSION}, and what this page shows works today. Some things come next, and the <a href="/direction/">direction page</a> lists them. The <a href="https://github.com/vyre-ai/vyre/blob/main/docs/known-gaps.md">known gaps</a> list what ${VERSION} does not do yet.`],
];

const homeBody = `
<section class="hero" aria-labelledby="hero-h">
  <div class="wrap">
    <div class="copy">
      <div class="hero-mark" aria-hidden="true">${vmark('hero', 'assemble', 'data-spread="near"')}</div>
      ${eyebrow('Open source. Apache 2.0. Self-hosted. Any model.')}
      <h1 id="hero-h" class="display">Vyre: <b>the agentic command center for AI-native teams</b></h1>
      <p class="mission">Our mission is to help every professional services team become AI-native.</p>
      <p class="lead">In an AI-native team, people set the direction and make the calls, and agents do the work: they draft, track, follow up and keep every job moving. Vyre gives both one place to work together, on servers the team owns, where anything that leaves the team waits for a person’s yes.</p>
      <div class="btn-row">
        <a class="btn btn-fill" href="/start/">Set up Vyre</a>
        <a class="btn" href="/architecture/">See the architecture</a>
      </div>
      <p class="hero-note">Free. Needs one AI account. <a href="${MAP_URL}">Point your AI agent at the repo</a>.</p>
    </div>
    <div class="stage">
      <canvas class="field" aria-hidden="true"></canvas>
      <div class="stage-in">
        <div class="stage-row">
          ${laptop('lap-chat', 'The Vyre app on a laptop: a chat where the agent juno has run the tests and now asks for a yes before it emails a client.')}
          ${phoneFrame('ph-now', 'The Vyre app on a phone, on the Now screen: what needs you today.')}
        </div>
        <p class="demo-tag">Recorded from the app. Sample data.</p>
      </div>
    </div>
  </div>
</section>

<section class="works" id="devices" aria-labelledby="works-h">
  <div class="wrap">
    <p class="lbl" id="works-h" style="margin-bottom:14px">Works on</p>
    <div class="frame rv"><span class="pl-a">+</span><span class="pl-b">+</span>
      <div class="works-grid">
        <a href="/mac/">${I.mac}<b>Mac</b><span>The Vyre app in its own window, with Touch ID.</span><i class="go">Mac &rarr;</i></a>
        <a href="/windows/">${I.win}<b>Windows</b><span>The Vyre app for Windows, connected to your server.</span><i class="go">Windows &rarr;</i></a>
        <a href="/linux/">${I.server}<b>Linux server</b><span>Where your agents live and keep working. A Mac that stays on works too.</span><i class="go">Server &rarr;</i></a>
        <a href="/phone/">${I.phone}<b>iPhone and Android</b><span>The Vyre app from a file, paired with Face ID or a fingerprint.</span><i class="go">Phone &rarr;</i></a>
      </div>
    </div>
  </div>
</section>

<section class="sec" id="product" aria-labelledby="pieces-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('What you get in 0.5.')}
      <h2 id="pieces-h" class="h2">One place for the team, <b>and the agents that work with it.</b></h2>
      <p class="lead">Where the outcome has to be exact, such as who sees a record, what a Flow does or what got sent, declared rules decide and a model does not.</p>
    </div>
    <div class="pieces p4 rv">
      <div class="piece"><span class="num">01</span>${I.records}<h3>Records</h3><p>Contacts, projects, tasks and the record types you define, with views, tags and Excel or CSV import. A sealed field shows an agent a placeholder, never the value.</p></div>
      <div class="piece"><span class="num">02</span>${I.flows}<h3>Flows</h3><p>Start from a person, a schedule, a record change, a stage, a form or a link. Steps find, create, wait, ask, assign and run an agent. A person approves a Flow before it runs.</p></div>
      <div class="piece"><span class="num">03</span>${I.chat}<h3>One group chat</h3><p>Claude, Codex, Grok and OpenRouter answer in the same chat. Give agents roles: a team that does the work, one model that reviews, one that plans.</p></div>
      <div class="piece"><span class="num">04</span>${I.stages}<h3>Playbooks and tracks</h3><p>A project template holds stages, the tasks in each and who does each task. Run each kind of work as its own track, with its own Playbook and Flows over shared records.</p></div>
      <div class="piece"><span class="num">05</span>${I.vault}<h3>Vault</h3><p>Passwords, API keys, logins with one-time codes, cards, notes and SSH keys. Share an item as Can use or Can edit. Agents use a credential without seeing it.</p></div>
      <div class="piece"><span class="num">06</span>${I.sites}<h3>Sites</h3><p>An agent builds a site, previews it at a private address and puts it live on your yes. Your own domain shows the DNS record to add.</p></div>
      <div class="piece"><span class="num">07</span>${I.doc}<h3>Documents</h3><p>Fill your own Word templates from a record and the records linked to it, as Word or PDF. A model never rewrites the document.</p></div>
      <div class="piece"><span class="num">08</span>${I.sign}<h3>Signing</h3><p>Send a document for signature from a record. The signer needs no account, and the signed copy files back on the record.</p></div>
    </div>
  </div>
</section>

<section class="sec" id="accounts" aria-labelledby="acc-h">
  <div class="wrap feat flip">
    <div class="feat-copy rv">
      <span class="num">One chat &middot; Any model</span>
      <h2 id="acc-h" class="h2">One group chat. <b>Every AI account you have.</b></h2>
      <p class="lead">A chat belongs to Vyre, not to one model. Change the model whenever you like and the thread, its files and its recall stay.</p>
      ${list([['The model picker', 'Choose the provider, account, model and effort from the composer.'], ['@codex, @grok', 'Add a name to one message to ask another model. The chat stays where it was.'], ['Agents in roles', 'Anyone in the Space can make an agent and share it with a person or a role as use-only or full. Give one the work, another the review, another the plan.'], ['See who answered', 'Each reply carries its provider’s mark, and a line says “Switched to Grok” when the model changes.']])}
    </div>
    <div class="mock rv">${laptop('lap-picker', 'The Vyre chat box with the Who answers menu open: Everyone, juno, Claude, Codex and Grok.')}</div>
  </div>
</section>

<section class="sec" id="agents" aria-labelledby="ag-h">
  <div class="wrap feat">
    <div class="feat-copy rv">
      <span class="num">Flows and agents</span>
      <h2 id="ag-h" class="h2">Work that runs the same way <b>every time.</b></h2>
      <p class="lead">A Flow starts from a trigger and runs steps. A step can give work to a person or to an agent. The agent wakes with the task, the record and the Flow it came from.</p>
      ${list([['Finish, hand on or say stuck', 'An agent ends a task as done, hands it on, or marks it stuck with a plain reason. A task is never left open in silence.'], ['People in the loop', 'A step can name an assignee, an approver and followers. A person approves a Flow before it runs, and every run has its own page.'], ['Readable dates', 'Text in a step fills in values, such as {today} or {after.starts_at - 1 day as date}, with a date picker to insert them.']])}
    </div>
    <div class="mock rv">${laptop('lap-flows', 'The Flows screen in the Vyre app: each Flow written out in plain words, grouped, with a switch.')}</div>
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
    <div class="mock rv">${laptop('lap-chat', 'A Vyre chat: juno runs the tests, then waits for a yes with Face ID before it sends a note to a client.')}</div>
  </div>
</section>

<section class="sec" id="memory" aria-labelledby="mem-h">
  <div class="wrap feat">
    <div class="feat-copy rv">
      <span class="num">Vault</span>
      <h2 id="mem-h" class="h2">Agents use a login <b>without seeing it.</b></h2>
      <p class="lead">The vault holds passwords, API keys, logins with one-time codes, cards, notes and SSH keys, in groups. Each member also has a vault of their own.</p>
      ${list([['Share and take back', 'Share an item with a person as Can use or Can edit, then revoke it.'], ['A placeholder, not the value', 'A model sees a placeholder. The real value is put in outside the model, at the moment of sending.'], ['A person says yes', 'Revealing a value, or sending with it, takes a person’s yes.']])}
    </div>
    <div class="mock rv">${laptop('lap-vault', 'The Vyre vault: a login whose value stays hidden, used by the agent juno with Can use.')}</div>
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
    <div class="mock rv" style="display:flex;justify-content:center">${phoneFrame('ph-now', 'The Vyre phone app on the Now screen, with what needs you.', 'width:min(100%,300px)')}</div>
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
      <div><p class="lbl">Vyre</p><p class="big">Free</p><p>Apache 2.0. Read it, change it, run it. Your data lives on your devices and on servers you or your team run. Vyre doesn’t hold it.</p></div>
      <div><p class="lbl">Your AI</p><p class="big">Your plans</p><p>Claude, Codex, Grok or OpenRouter, on the subscriptions or keys you already have.</p></div>
      <div><p class="lbl">Your machine</p><p class="big">One server</p><p>A Linux server with Docker, or a Mac that stays on.</p></div>
    </div>
  </div>
</section>

<section class="sec" id="agent-guide" aria-labelledby="agt-h">
  <div class="wrap">
    <div class="note rv">
      <p class="lbl" id="agt-h" style="margin-bottom:8px">For your AI agent</p>
      <p style="margin:0 0 10px"><b>See how your business would run on Vyre.</b> An agent reads the repo and follows a method that turns a business into members, records, Playbooks, Flows, agents, documents, sites and Gate rules.</p>
      <p style="margin:0"><a class="btn btn-fill btn-sm" href="${MAP_URL}">Point your AI agent at the repo</a> <a class="btn btn-sm" href="/architecture/">Read the architecture</a></p>
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
        <li><b>Add your computers.</b> The Vyre app for <a href="/mac/">Mac</a> and <a href="/windows/">Windows</a> pairs to your server.</li>
      </ol>
    </div>
  </div>
</section>

<section class="sec" id="direction" aria-labelledby="dir-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Where Vyre is going.')}
      <h2 id="dir-h" class="h2">A workplace for your team <b>and its AI agents.</b></h2>
      <p class="lead">This is direction, not a promise of dates.</p>
    </div>
    <div class="pieces rv" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
      <div class="piece"><span class="num">Now &middot; 0.5</span><h3>Agents and people, one place</h3><p>Records, Flows, Playbooks, one group chat across providers, a Vault, Sites, Documents and Signing.</p></div>
      <div class="piece"><span class="num">Next &middot; 0.5.1</span><h3>Flows you can trust</h3><p>One chat per Flow, deadlines on agent steps, a failure panel on every step, and per-record privacy for custom record types.</p></div>
      <div class="piece"><span class="num">After that &middot; 0.5.2</span><h3>Integrations and skills</h3><p>An Integration wraps an outside app. Clio, Lawmatics, GoHighLevel and DecisionVault are planned, with screens for skills and plugins.</p></div>
      <div class="piece"><span class="num">Later</span><h3>Screen Share and more</h3><p>Watch and take over your agents' computers, the iPhone App Store app, and a hosted option.</p></div>
    </div>
    <div class="btn-row"><a class="btn" href="/direction/">Read the direction</a></div>
  </div>
</section>


<section class="sec" id="faq" aria-labelledby="faq-h">
  <div class="wrap feat faq-wrap">
    <div class="feat-copy rv">
      <span class="num">Any questions?</span>
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
  title: 'Vyre: the agentic command center for AI-native teams',
  desc: 'Open-source, self-hosted command center where people and AI agents share chats, records, Flows, a vault, sites and documents. Built for professional services teams.',
  ogTitle: 'The agentic command center for AI-native teams.',
  ogSub: 'Our mission is to help every professional services team become AI-native.',
  body: homeBody, ld: [SOFT(), { '@type': 'WebSite', '@id': `${SITE}/#site`, url: `${SITE}/`, name: 'Vyre', publisher: { '@id': `${SITE}/#org` } }, faqLd(HOME_FAQ)],
});

// ---------- device pages ----------
// ---------- downloads ----------
const dlBtn = (file, label, fill = false) => `<a class="btn btn-sm${fill ? ' btn-fill' : ''}" href="${DL}/${file}" download>${label}</a>`;
(() => {
  const faq = [
    ['Do the links always give the newest version?', 'Yes. Each button points at GitHub’s latest release, so it serves the newest file and the version on this page moves with each release.'],
    ['Is there a Windows file besides the installer?', 'The PowerShell line and VyreSetup.exe do the same thing. The installer file is the one to double-click; the line is for a terminal.'],
    ['Why is there no app store link?', 'The phone apps are not on a store yet. Android installs from a file you open on the phone. iPhone is built and installed with Xcode.'],
    ['How do I know a file is what the release signed?', 'Every file is listed in SHA256SUMS, and SHA256SUMS.sig is an Ed25519 signature over that list by the release key. The Vyre app and the install line check it for you; to check it yourself, read the release page.'],
  ];
  const card = (ico, h, p, acts, foot) => `<div class="dl rv"><span class="dl-ic">${ico}</span><h3>${h}</h3><p>${p}</p><div class="dl-acts">${acts}</div><div class="dl-foot">${foot}</div></div>`;
  const body = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Downloads</p>
    ${eyebrow('Vyre ' + VERSION)}
    <h1 class="display">Everything you can install, <b>in one place.</b></h1>
    <p class="lead">The apps for your computers and phone, the line that sets up your server, and the web app. Every link points at the latest release.</p>
    <div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="${REPO}/releases/latest">Release page</a></div>
  </div>
</section>
<section class="sec" id="apps" aria-labelledby="apps-h">
  <div class="wrap">
    <div class="sec-head rv"><span class="lbl" id="apps-h">The apps</span></div>
    <div class="dl-grid">
      ${card(I.mac, 'Mac', 'The Vyre app in its own window, with Touch ID. Apple silicon or Intel.', dlBtn('Vyre-aarch64.dmg', 'Apple silicon', true) + dlBtn('Vyre-x86_64.dmg', 'Intel'), '<a href="/mac/">How it works on a Mac</a>')}
      ${card(I.win, 'Windows', 'A tray app with an Alt+Space panel. Run the installer, or paste the line in PowerShell.', dlBtn('VyreSetup.exe', 'VyreSetup.exe', true), term('irm vyre.run/w | iex', 'irm vyre.run/w | iex') + '<a href="/windows/">How it works on Windows</a>')}
      ${card(I.phone, 'Android', 'The Vyre app from a file. Open it on the phone and allow installs when Android asks.', dlBtn('Vyre-android.apk', 'Vyre-android.apk', true), '<a href="/phone/">Pair your phone</a>')}
      ${card(I.phone, 'iPhone', 'There is no App Store app yet. You build the app and install it with Xcode on a Mac.', `<a class="btn btn-sm btn-fill" href="${REPO}/blob/main/docs/using/mobile.md">Install with Xcode</a>`, '<a href="/phone/">Pair your phone</a>')}
      ${card(I.doc, 'Every file', 'The checksums, the signature and every other file of the release are on the release page.', `<a class="btn btn-sm btn-fill" href="${REPO}/releases/latest">Release page</a>`, `<a href="${DL}/SHA256SUMS">SHA256SUMS</a>`)}
      ${card(I.sites, 'Web app', 'Vyre in any browser, with nothing to install. Log in with your passkey.', `<a class="btn btn-sm btn-fill" href="${APP_URL}">Open the web app</a>`, 'The same app as the desktop and phone apps.')}
    </div>
  </div>
</section>
<section class="sec" id="server" aria-labelledby="srv-h">
  <div class="wrap feat">
    <div class="feat-copy rv"><span class="num">Your server</span><h2 id="srv-h" class="h2">One line <b>sets up the server.</b></h2><p class="lead">Your agents live on a machine that stays on. Run the line as yourself, not as root. The app shows the same line with your code in it.</p></div>
    <div class="rv">
      <p class="lbl" style="margin:0 0 6px">Linux server</p>
      ${term('curl -fsSL vyre.run/i | sh', 'curl -fsSL vyre.run/i | sh')}
      <p class="sm" style="margin:6px 0 22px">Linux with Docker Compose 2.24 or newer. <a href="/linux/">More on the Linux server</a></p>
      <p class="lbl" style="margin:0 0 6px">A Mac that stays on</p>
      ${term('curl -fsSL vyre.run/i | sh', 'curl -fsSL vyre.run/i | sh')}
      <p class="sm" style="margin:6px 0 0">Run it in Terminal. The Mac asks for its password once so Vyre starts when the Mac does. <a href="/start/">The steps in order</a></p>
    </div>
  </div>
</section>
<section class="sec" id="verify" aria-labelledby="ver-h">
  <div class="wrap feat flip">
    <div class="feat-copy rv"><span class="num">Check what you download</span><h2 id="ver-h" class="h2">Every file is <b>signed.</b></h2><p class="lead">The release lists each file and its checksum, and signs that list with a key the Vyre app and the install line already know.</p></div>
    <div class="rv">
      ${list([['SHA256SUMS', `The checksum of every file in the release. <a href="${DL}/SHA256SUMS">Download SHA256SUMS</a>`], ['SHA256SUMS.sig', `An Ed25519 signature over that list, by the release key. <a href="${DL}/SHA256SUMS.sig">Download SHA256SUMS.sig</a>`], ['The release page', `Release notes, every file and how to check them. <a href="${REPO}/releases/latest">Open the latest release</a>`]])}
    </div>
  </div>
</section>
<section class="sec" aria-labelledby="faq-h">
  <div class="wrap feat faq-wrap"><div class="feat-copy rv"><span class="num">Questions</span><h2 id="faq-h" class="h2">Questions about <b>downloads.</b></h2></div>${faqHtml(faq)}</div>
</section>
<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">Set up <b>Vyre.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/start/">Read the steps</a><a class="btn" href="/">Back to vyre.run</a></div></div></section>`;
  page({
    slug: 'downloads', path: '/downloads/', title: 'Download Vyre: Mac, Windows, Android, iPhone, Linux and the web app',
    desc: 'Every Vyre download in one place: the Mac app for Apple silicon and Intel, the Windows installer, the Android file, how to install on iPhone, the Linux server line and the web app.',
    body, ogTitle: 'Download Vyre.', ogSub: 'Mac, Windows, Android, iPhone, the Linux server line and the web app, all from the latest release.',
    ld: [crumbs([['Vyre', `${SITE}/`], ['Downloads', `${SITE}/downloads/`]]), faqLd(faq)],
  });
})();

function devicePage({ slug, os, name, crumb, h1, lead, ogSub, desc, title, art, what, steps, needs, gapList, faq, extra = '' }) {
  const path = `/${slug}/`;
  const body = `
<section class="phead">
  <div class="wrap${art ? ' feat' : ''}">
    <div class="feat-copy">
      <p class="crumbs"><a href="/">Vyre</a> / ${crumb}</p>
      ${eyebrow(name)}
      <h1 class="display">${h1}</h1>
      <p class="lead">${lead}</p>
      <div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="/start/">Read the steps</a></div>
    </div>
    ${art ? `<div class="mock rv">${art}</div>` : ''}
  </div>
</section>
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
  <div class="wrap feat faq-wrap"><div class="feat-copy rv"><span class="num">Questions</span><h2 id="faq-h" class="h2">Questions about <b>${name}.</b></h2></div>${faqHtml(faq)}</div>
</section>
<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">Set up <b>Vyre.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/start/">Read the steps</a><a class="btn" href="/">Back to vyre.run</a></div></div></section>`;
  page({
    slug, path, title, desc, body, ogTitle: h1.replace(/<[^>]+>/g, ''), ogSub,
    ld: [SOFT({ '@id': `${SITE}${path}#app`, name: `Vyre for ${crumb}`, url: SITE + path, operatingSystem: os }), crumbs([['Vyre', `${SITE}/`], [crumb, SITE + path]]), faqLd(faq)],
  });
}

devicePage({
  slug: 'mac', os: 'macOS', name: 'Vyre on Mac', crumb: 'Mac',
  title: 'Vyre for Mac: the Vyre app in a window',
  desc: 'The Vyre app for Mac is the Vyre web app in its own window, with Touch ID for your approvals. Your agents run on your own server.',
  h1: 'The Vyre app, <b>in its own window on your Mac.</b>',
  lead: 'Download it, open it, and the app walks you through connecting to your server. Your agents run on your server; the Mac app is the window.',
  ogSub: 'The Vyre app in its own window on your Mac, with Touch ID for approvals.',
  art: `${laptop('lap-chat', 'The Vyre app on a Mac, in a chat with an agent.')}`,
  what: { h: 'The same app, <b>with a Mac window.</b>', items: [
    ['One window', 'Opens on launch and when you open the app again. The menu bar icon has Open Vyre and Quit Vyre.'],
    ['Touch ID', 'Approve what needs your yes with Touch ID.'],
    ['Your files', 'Drop a file onto the app to hand it to an agent.'],
    ['Your server', 'Everything runs on your own server; the app connects to it.'],
  ] },
  steps: { h: 'Download the app, <b>then connect it.</b>', lead: 'Get the Mac app from the latest release.', items: [
    `<b>Download it.</b> <code>Vyre-aarch64.dmg</code> for Apple silicon or <code>Vyre-x86_64.dmg</code> for an Intel Mac, from <a href="https://github.com/vyre-ai/vyre/releases/latest">the latest release</a>. Open it and drag Vyre to Applications.`,
    `<b>Open it once.</b> If macOS says it cannot check the app, choose Open Anyway in System Settings, Privacy and Security.`,
    `<b>Follow the app.</b> It asks whether to connect to your server or set one up, and walks you through it.`,
  ] },
  needs: [['Mac', 'macOS 14 or newer'], ['Server', 'A Linux server, or another Mac that stays on'], ['AI', 'One of Claude, Codex, Grok or OpenRouter']],
  extra: `<p class="lead rv" style="margin-top:28px">A Mac that stays on can be your server too: run the install line in Terminal.</p>`,
  gapList: ['The Mac app is not yet signed with an Apple Developer ID, so you open it once with Open Anyway.'],
  faq: [
    ['Do I need the Mac app to use Vyre?', 'No. Your agents run on your server and the Vyre app opens in any browser.'],
    ['Can my Mac be the server?', 'Yes, a Mac that stays on can be the server. A Linux server is the best home, because agents keep working when a laptop sleeps.'],
    ['Does the app need Touch ID?', 'Only to approve what needs your yes.'],
  ],
});

devicePage({
  slug: 'windows', os: 'Windows', name: 'Vyre on Windows', crumb: 'Windows',
  title: 'Vyre for Windows: the Vyre app in your tray',
  desc: 'Vyre for Windows is a tray app with an Alt+Space panel. Pair your PC to your own Vyre server, ask your agents, and map your shared folder as a drive.',
  h1: 'Vyre, <b>in your Windows tray.</b>',
  lead: 'A tray icon and an Alt+Space panel, connected to your Vyre server. Pair a PC with 13 words or a QR code from your other device.',
  ogSub: 'A tray icon and an Alt+Space panel, connected to your own Vyre server.',
  art: `${appwin('lap-vault', 'The Vyre app in a window on Windows: the vault.')}`,
  what: { h: 'The same window, <b>on your PC.</b>', items: [
    ['A tray app', 'A Vyre icon in your tray, and an Alt+Space panel to ask from.'],
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
  gapList: ['The app is not code-signed (Authenticode) yet, so Windows warns on first run. Signing comes next.', 'Mapping the drive for files over 50 MB needs a registry change by an administrator.', 'A Windows PC is a device, never the home: it joins a team or connects to a server that runs on a Linux machine or a Mac that stays on.'],
  faq: [
    ['Can my Windows PC be the server?', 'Not yet. The server runs on Linux or on a Mac that stays on, and your Windows PC joins a team or connects to that server.'],
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
  art: `<div style="display:flex;justify-content:center">${phoneFrame('ph-chat', 'The Vyre phone app in a chat with an agent.', 'width:min(100%,300px)')}</div>`,
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
  gapList: ['Nothing has been walked on a real iPhone or Android yet, including Face ID pairing and the removed-phone wipe.', 'Notifications to a closed phone app are not set up: Apple and Google push accounts are needed. Open the app to see what is waiting.', 'Screen Share (live view and computer use) comes later; Chrome control works today.'],
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
    ${eyebrow('Where Vyre is, and where it is going.')}
    <h1 class="display">A workplace for your team <b>and its AI agents.</b></h1>
    <p class="lead">AI tools are brilliant in a chat window and lost everywhere else: they don\'t know your clients, can\'t pick up a colleague\'s task, can\'t safely use your company\'s accounts, and nothing they do is checked before it goes out. Vyre is the place where they can, on a server you own.</p>
  </div>
</section>
<section class="sec" style="padding-top:64px" aria-labelledby="now-h">
  <div class="wrap">
    <h2 id="now-h" class="lbl" style="margin-bottom:28px">Where Vyre is today &middot; ${VERSION}</h2>
    <div class="road">
      <div class="stop now rv"><p class="ver">Released &middot; 0.5</p><h3>What you can use now</h3><ul><li><b>People and agents in the same chats</b>@ a teammate or an agent, # a record, a file or a project. Anyone in the Space can make an agent and share it as use-only or full.</li><li><b>Agents that wake on a task</b>An agent finishes the task, hands it on, or marks it stuck with a plain reason.</li><li><b>Flows</b>Triggers from a person, a schedule, a record change, a stage, a form or a link, and steps that find, create, wait, ask, assign and run an agent. A person approves a Flow before it runs.</li><li><b>Playbooks</b>Stages, the tasks in each stage, who does each task, and when a stage counts as done.</li><li><b>Records</b>Contacts, projects, tasks and your own record types, with tags, saved views, and Excel or CSV import.</li><li><b>Documents and signing</b>Fill your Word templates from a record, as Word or PDF, and send for signature. A signer needs no account.</li><li><b>Files</b>One Files place for the Space, with linked Google Drive and Dropbox folders.</li><li><b>Vault</b>Ten groups, shared as Can use or Can edit, and a vault of their own for every member.</li><li><b>Sites</b>An agent builds a site and puts it live with one yes from you.</li><li><b>Needs you</b>One place for approvals, asks and stuck tasks, with typed cards.</li><li><b>Teams</b>Roles, per-project seat levels, invites with a role, and a Space-wide Google or Microsoft 365 key for each member\'s own mail, calendar and drive.</li><li><b>Sign in by name</b>Sign in by name replaces the pairing code, and updates need the owner\'s yes.</li></ul></div>
    </div>
  </div>
</section>
<section class="sec" aria-labelledby="road-h">
  <div class="wrap">
    <h2 id="road-h" class="lbl" style="margin-bottom:28px">Where Vyre is going</h2>
    <div class="road">
      <div class="stop rv"><p class="ver">Next &middot; 0.5.1</p><h3>Flows you can trust</h3><ul><li><b>One chat per Flow</b>A divider for each run.</li><li><b>Deadlines on agent steps</b>An agent step that runs too long is stopped and takes a timeout path.</li><li><b>A failure panel</b>On every step in the Flows editor.</li><li><b>Per-record privacy</b>For custom record types.</li><li><b>Flow email</b>With CC, BCC and attachments.</li><li><b>An audit screen</b>For admins: who changed what on a record.</li></ul></div>
      <div class="stop rv"><p class="ver">After that &middot; 0.5.2</p><h3>Integrations and skills</h3><ul><li><b>Integrations</b>An Integration wraps an outside app\'s API and ships its own Flow steps, triggers, connection and agent tools. Clio, Lawmatics, GoHighLevel and DecisionVault are planned.</li><li><b>Make an Integration from an API</b>An agent can build one for your business on your own server.</li><li><b>Skills and Plugins</b>Browse, write, version and roll back skills. Install and enable plugins per agent and project.</li></ul></div>
      <div class="stop rv"><p class="ver">Later</p><h3>And beyond</h3><ul><li><b>Screen Share</b>Watch and take over your agents\' computers and browsers from any device.</li><li><b>iPhone App Store</b>The iPhone app from the App Store, with notifications.</li><li><b>A hosted option</b>A Vyre-hosted home for people without a server.</li></ul></div>
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
  title: 'Where Vyre is, and where it is going',
  desc: 'Vyre is becoming a workplace where your team and its AI agents do real work together, on a server you own: where it is today and where it is going. Direction, not a promise of dates.',
  ogTitle: 'Where Vyre is going.', ogSub: 'A workplace for your team and its AI agents, on a server you own.',
  body: DIR, ld: [crumbs([['Vyre', `${SITE}/`], ['Direction', `${SITE}/direction/`]])],
});

// ---------- architecture page ----------
// The system in one designed view, drawn in HTML and CSS (classes ar-* in v2.css). Wording follows docs/architecture/overview.md.
const node = (n, t, d) => `<li class="ar-node"><span class="ar-n">${n}</span><b>${t}</b><span>${d}</span></li>`;
const ARCH = `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Architecture</p>
    ${eyebrow('How Vyre is built.')}
    <h1 class="display">The architecture, <b>on one page.</b></h1>
    <p class="lead">Vyre is one product for a team and its agents. It runs on a server you own and on the computers your people use. This page shows the layers, how a call is checked, how an agent’s turn runs and how the Gate holds anything that leaves your server.</p>
  </div>
</section>

<section class="sec" style="padding-top:56px" aria-labelledby="ideas-h">
  <div class="wrap">
    <h2 id="ideas-h" class="lbl" style="margin-bottom:20px">Three ideas shape all of it</h2>
    <div class="ar-ideas rv">
      <div class="piece"><span class="num">01</span><h3>One small trusted core</h3><p>The code that decides who may do what, keeps the history and holds secrets is small and separate. Features are modules around it, and a module cannot invent a new kind of permission.</p></div>
      <div class="piece"><span class="num">02</span><h3>A person decides</h3><p>Anything that leaves your server waits until a person has seen the exact words and approved them. An agent can ask. It cannot approve.</p></div>
      <div class="piece"><span class="num">03</span><h3>Secrets stay out of the model’s reach</h3><p>A model sees a placeholder. The real value is put in outside the model, at the moment of sending.</p></div>
    </div>
  </div>
</section>

<section class="sec" id="layers" aria-labelledby="layers-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('The layers.')}
      <h2 id="layers-h" class="h2">From the app to the kernel, <b>and out to the world.</b></h2>
      <p class="lead">Every machine runs the same daemon. Its config says whether the machine is a server, a solo Mac or a device that joins a server, and that picks which modules start.</p>
    </div>

    <div class="ar-sys rv" role="group" aria-label="The layers of Vyre, top to bottom: surfaces, the relay, the daemon with its door, modules and kernel, and beside the daemon a person’s own computer and outside services.">
      <div class="ar-main">
        <div class="ar-layer">
          <p class="ar-tag">Surfaces</p>
          <div class="ar-cols3">
            <div class="ar-box"><b>The Vyre app</b><span>Web, iPhone, Android, Mac and Windows</span></div>
            <div class="ar-box"><b>The vyre command line</b><span>For the terminal on any machine</span></div>
            <div class="ar-box"><b>Outside AI tools</b><span>Connected over MCP</span></div>
          </div>
        </div>

        <div class="ar-paths" aria-hidden="false">
          <div class="ar-path"><span>Straight to the door</span><i class="ar-line"></i></div>
          <div class="ar-path ar-relay"><i class="ar-line"></i><div class="ar-box ar-dash"><b>Relay</b><span>Away from home, an encrypted path to a server with no open port</span></div><i class="ar-line"></i></div>
        </div>

        <div class="ar-daemon">
          <p class="ar-tag ar-tag-acc">One daemon on each machine</p>
          <div class="ar-door"><b>Door</b><span>Works out who is calling, builds that caller’s chain and applies the role’s tool list</span></div>
          <i class="ar-down" aria-hidden="true"></i>
          <div class="ar-mods">
            <div class="ar-mod"><p class="lbl">Work</p><ul><li>Chats</li><li>Tasks</li><li>Records</li><li>Flows</li><li>Agents</li><li>Documents</li></ul></div>
            <div class="ar-mod"><p class="lbl">Keep</p><ul><li>Files</li><li>Vault</li><li>Memory</li></ul></div>
            <div class="ar-mod ar-out"><p class="lbl">Outward</p><ul><li>Gate</li><li>Publish</li><li>Connections</li></ul></div>
            <div class="ar-mod ar-run"><p class="lbl">Run</p><ul><li>Sessions</li><li>Providers</li><li>Model routing</li></ul></div>
          </div>
          <i class="ar-down" aria-hidden="true"></i>
          <div class="ar-kernel">
            <p class="ar-tag">Kernel</p>
            <div class="ar-cols5">
              <div class="ar-cell"><b>Identity</b><span>Keys and devices</span></div>
              <div class="ar-cell"><b>Grants</b><span>And five roles</span></div>
              <div class="ar-cell"><b>Event log</b><span>Hash-linked</span></div>
              <div class="ar-cell"><b>Flow runner</b><span>Runs Flows</span></div>
              <div class="ar-cell"><b>Sealing</b><span>Secrets, in a child process</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="ar-side">
        <div class="ar-hook ar-hook-run">
          <span class="ar-chip">Run</span>
          <div class="ar-box"><b>A person’s own computer</b><span>Sandboxed sessions in an encrypted workspace, computer use, the Mac app</span></div>
        </div>
        <div class="ar-hook ar-hook-out">
          <span class="ar-chip">Outward, only after a person’s yes</span>
          <div class="ar-box"><b>Outside services</b><span>Mail, calendar, Drive, Dropbox, payments and DNS</span></div>
        </div>
      </div>
    </div>

    <div class="ar-table rv">
      <div><p class="lbl">Kernel</p><p>Identity, grants and the five roles, the event log, tasks and approvals, sealing, and the Flows engine. Almost no dependencies, and the same code runs on a server, a phone and a browser.</p></div>
      <div><p class="lbl">Core modules</p><p>The services features are made of: records, chats, files, vault, the Gate, agents, sessions, publishing, documents and connections. Each is a folder with a manifest.</p></div>
      <div><p class="lbl">Apps</p><p>One Expo codebase for web, iPhone and Android, and the Mac and Windows shells around it. They talk to the daemon’s API and never read a store directly.</p></div>
      <div><p class="lbl">Relay</p><p>Lets a paired device reach a server with no open port. It carries only encrypted traffic between devices that proved each other’s keys.</p></div>
      <div><p class="lbl">Local helpers</p><p>Code on a person’s own computer: running a Space’s sessions in a sandbox, computer use, the Mac app.</p></div>
    </div>
  </div>
</section>

<section class="sec" id="call" aria-labelledby="call-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('How a call flows.')}
      <h2 id="call-h" class="h2">Every caller goes <b>through the same check.</b></h2>
      <p class="lead">A person in the app, an agent in a session, a Flow step and an outside AI over MCP all make calls the same way.</p>
    </div>
    <ol class="ar-flow ar-flow5 rv">
      ${node(1, 'The caller', 'A person, an agent or a Flow calls a tool by name.')}
      ${node(2, 'The door', 'Builds the chain from facts the daemon verified itself, then applies the role’s tool list.')}
      ${node(3, 'Authorize', 'The kernel answers allow, ask or deny for this chain, this action and this resource.')}
      ${node(4, 'The tool', 'A module tool does the work. Every read and write of a record goes through one gateway.')}
      ${node(5, 'The log', 'Every decision and change is an event: who, what, when and the full chain.')}
    </ol>
    <div class="ar-outcomes rv">
      <div class="ar-out-card ar-allow"><p class="lbl">Allow</p><p>The tool runs as that chain, writes what changed and returns the result.</p></div>
      <div class="ar-out-card ar-ask"><p class="lbl">Ask</p><p>The call is held and becomes a task for a person.</p></div>
      <div class="ar-out-card ar-deny"><p class="lbl">Deny</p><p>The caller is told the thing is not found. The real reason goes to the log.</p></div>
    </div>
    <ul class="ar-facts rv">
      <li><b>The chain is never a name or a header.</b>It is the paired device, the signed session, the agent that person started and the Flow step. The call has the intersection of what every link may do, so an agent never has more than the person who started it.</li>
      <li><b>The log can be checked.</b>Events are hash-linked and checkpointed, so a rollback is detectable.</li>
    </ul>
  </div>
</section>

<section class="sec" id="turn" aria-labelledby="turn-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('How an agent’s turn runs.')}
      <h2 id="turn-h" class="h2">A message or a task in, <b>tool calls back through the door.</b></h2>
    </div>
    <ol class="ar-flow ar-flow5 rv">
      ${node(1, 'A message or a task', 'A message in a chat, or a task given to an agent by a person, a tool or a Flow step.')}
      ${node(2, 'Model routing', 'Starts headless sessions and streams them to every surface. A chat is a Vyre thread, so changing provider mid-conversation loses nothing.')}
      ${node(3, 'Session driver', 'One driver for each provider: Claude, Codex, Grok or OpenRouter, on the account you added.')}
      ${node(4, 'The provider', 'Claude Code, Codex and Grok run as their own command-line agents with only Vyre’s tools connected.')}
      ${node(5, 'Vyre’s tools', 'Every tool call the model makes comes back through the door, as the person or agent the session belongs to.')}
    </ol>
    <div class="ar-where rv">
      <div class="ar-box"><b>On a person’s own computer</b><span>A sandbox and an encrypted workspace that opens only while the Space leases its key. The chat shows where it runs.</span></div>
      <div class="ar-box"><b>On the server</b><span>When a session does not run on a person’s computer, it runs here. A chat can move between the two with its turns.</span></div>
    </div>
    <ul class="ar-facts rv">
      <li><b>Waking on a task.</b>The agent starts one job session with the task, its record and where it came from. It finishes the task, hands it on, or marks it stuck, and a job that ends without doing so is marked stuck with the reason.</li>
      <li><b>Instructions.</b>Each agent and each project has an AGENTS.md. A session starts in its project’s folder and reads it natively.</li>
    </ul>
  </div>
</section>

<section class="sec" id="gate" aria-labelledby="gate-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('The Gate.')}
      <h2 id="gate-h" class="h2">Everything that leaves your server <b>waits for a person.</b></h2>
      <p class="lead">The Gate is the hold queue for an email, a text, a post, a payment, a delete and a publication.</p>
    </div>
    <ol class="ar-flow ar-flow6 rv">
      ${node(1, 'Wants to send', 'An agent or a Flow asks, with the text, the recipient and the reason.')}
      ${node(2, 'Held', 'The request appears in Needs you.')}
      ${node(3, 'A person reads', 'They read the exact words and edit them if they want.')}
      ${node(4, 'Approves', 'With a hardware proof over those exact words. It works once.')}
      ${node(5, 'The Vault', 'The credential is fetched at send time. The model never sees it.')}
      ${node(6, 'Sent', 'Exactly the approved words.')}
    </ol>
    <ul class="ar-facts rv">
      <li><b>An agent cannot approve, revise or reject.</b>Those calls refuse an agent caller.</li>
      <li><b>The proof is a signature over the exact request.</b>It is made on the person’s own device with Face ID, Touch ID, Windows Hello or a passkey, and works once for that act only.</li>
      <li><b>Outward is declared, not guessed.</b>A connector marks each operation as read, draft, change, send, spend or delete, and anything undeclared cannot be called.</li>
      <li><b>A failed send goes back to held.</b>Two screens approving at once send once.</li>
    </ul>
  </div>
</section>

<section class="sec" id="data" aria-labelledby="data-h">
  <div class="wrap">
    <div class="sec-head rv">
      ${eyebrow('Where data lives.')}
      <h2 id="data-h" class="h2">On your server and <b>on your devices.</b></h2>
    </div>
    <div class="ar-data rv">
      <div><p class="lbl">Records</p><p>The built-in SQLite store, or one Twenty CRM database for each Space behind the same interface.</p></div>
      <div><p class="lbl">Files</p><p>The Space’s Drive: encrypted chunks over local disk, S3 or a device. Linked Google Drive and Dropbox folders stay at the source and are read through each person’s own account.</p></div>
      <div><p class="lbl">Vault items</p><p>Sealed at rest. A member’s own vault opens with their own master password and Secret Key.</p></div>
      <div><p class="lbl">Sealed fields</p><p>Only inside the sealing process, a separate child process.</p></div>
      <div><p class="lbl">Keys that prove a person is there</p><p>Hardware on the person’s device: Secure Enclave, TPM, StrongBox or a passkey. They never reach the server.</p></div>
      <div><p class="lbl">Chat sessions</p><p>The machine that ran them. A chat can move between a person’s computer and the server with its turns.</p></div>
    </div>
  </div>
</section>

<section class="sec" aria-labelledby="go-h">
  <div class="wrap">
    <div class="note rv">
      <p class="lbl" id="go-h" style="margin-bottom:8px">Go deeper</p>
      <p style="margin:0 0 12px">Every claim on this page is explained in the repository, with the code paths. <a href="${REPO}/blob/main/docs/architecture/overview.md">The architecture overview</a> takes ten minutes. <a href="${REPO}/blob/main/ARCHITECTURE.md">ARCHITECTURE.md</a> lists one page for each feature. An AI agent can follow <a href="${MAP_URL}">Map your business onto Vyre</a> to see how a business would run on it.</p>
      <p style="margin:0"><a class="btn btn-sm" href="${REPO}/blob/main/docs/architecture/overview.md">Read the overview</a> <a class="btn btn-sm" href="${REPO}/blob/main/ARCHITECTURE.md">ARCHITECTURE.md</a></p>
    </div>
  </div>
</section>

<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">See it <b>working.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="/">Back to vyre.run</a></div></div></section>`;
page({
  slug: 'architecture', path: '/architecture/',
  title: 'Vyre architecture: layers, calls, agent turns and the Gate',
  desc: 'How Vyre is built, on one page: the layers from the app to the kernel, how a call is checked, how an agent’s turn runs, and the Gate that holds anything that leaves your server.',
  ogTitle: 'The architecture, on one page.', ogSub: 'Layers, how a call is checked, how an agent’s turn runs, and the Gate.',
  body: ARCH, ld: [crumbs([['Vyre', `${SITE}/`], ['Architecture', `${SITE}/architecture/`]])],
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
${part('02', 'app', 'Install the app', `<p><strong>Mac:</strong> download <a href="https://github.com/vyre-ai/vyre/releases/latest">Vyre-aarch64.dmg</a> (Apple silicon) or Vyre-x86_64.dmg (Intel), open it and drag Vyre to Applications. Open it once; if macOS says it cannot check the app, choose Open Anyway in System Settings, Privacy and Security. More on the <a href="/mac/">Mac page</a>.</p>
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
<li><strong>Screen Share.</strong> Screen Share (live view and computer use) comes later; Chrome control works today.</li>
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
  'The marketing pages serve their fonts from vyre.run itself, so no font request goes to another company. The server behind <code>app.vyre.run</code> sets no cookies and keeps nothing about you or your server; the page keeps your device key, server address and pairing in your browser, as section 08 lists.',
  '<b>Two optional lookups:</b> the weather action sends a city name (by default one derived from your time zone) to <code>open-meteo.com</code>. The device sign-in page that your own server serves loads its fonts from that server.',
  'The pages are served by Cloudflare, which keeps ordinary server logs under its own policy.',
  '<b>Updates:</b> your server checks GitHub\'s releases API for new versions and pulls signed images from <code>ghcr.io</code>; the Windows app checks GitHub\'s releases feed once a day and downloads its installer from GitHub; the install line fetches from <code>vyre.run</code>. Those services see the address your server or PC connects from, under their own policies. Vyre itself receives no report of which version you run.',
])}`)}
${part('08', 'apps', 'What each app keeps on your device', `${ul([
  '<b>The Vyre app in a browser or on a Home Screen</b> keeps in the browser\'s own storage: a device key the browser cannot export, the key that opens your private chats and notes, the pairing with your server, a cache of recent views (needs rows, the chat list and snippets), your pins, unsent drafts, recent searches, your appearance settings, where setup stopped, an outbox of writes not yet delivered, and cached app files. The browser\'s push service holds your push subscription, and the app sends it to your server. The web app keeps no unlock session: the browser asks for your passkey on each protected call. On a phone, keys and the pairing sit in the phone\'s secure store, and an unlock session lasts 30 minutes after you confirm. When the owner removes a device, it forgets all of this the next time it reaches Vyre and asks to be paired again; a device that is offline keeps it until then. Two more limits: an old browser that cannot list its databases has only the app\'s four named databases deleted, and a sign-in cookie that your server sets (when the app is opened at your server\'s own address) belongs to the server, which refuses a removed device anyway.',
  '<b>The hosted web app at app.vyre.run</b> keeps two keys the browser cannot export, the pairing record in localStorage, the relay key in IndexedDB and cached app files. It has no wipe: sign out and clear the site\'s data in your browser.',
  '<b>The phone app (iPhone and Android)</b> makes two keys in secure hardware where the phone has it, the Secure Enclave on iPhone and the Android Keystore on Android (some phones fall back to software). One signs its requests, and the other signs only after your face or fingerprint. They cannot be exported. Your sign-in tokens and the pairing with your server are kept in the system Keychain or Keystore. On iPhone those items are marked this-device-only; on Android, backup follows Android\'s own backup rules. The view of recent threads and lists is held in memory and is gone when you close the app. Signing in on your own address opens the system sign-in browser. Pairing links open the app. The app declares no camera, microphone, location, contacts or photos permission, and this version has no notifications.',
  '<b>The Vyre app on a Mac</b> keeps its approval key in the Secure Enclave where the Mac has one, with only an opaque handle in the login keychain; a Mac without one keeps a software key in the login keychain. It talks to your server.',
  '<b>The Vyre app on Windows</b> keeps your server\'s address in a pairing file and its device key in its app data folder, with the key protected by Windows DPAPI. The installer for a newer version is saved there before it runs. Starting at sign-in uses a Windows scheduled task named Vyre, which the app creates and deletes when you change that setting.',
  '<b>Password AutoFill</b> (in the Android phone app, and on iPhone and Mac in builds that include the extension) asks your server for one login at a time, after you confirm with your face or fingerprint. On iPhone and Mac it keeps the server address and a device token in the Keychain and the unlocked session in memory only, and gives the system the sites, usernames, passkey names and one-time-code labels from your vault, never passwords, passkey private keys or code seeds. On Android the address and token sit in Keystore-protected storage, and it uses its own biometric key.',
  '<b>The vault browser extension</b> keeps the address of your server, this browser\'s device id and token, and its two on and off choices in the extension\'s storage, and the unlocked session in session storage. It talks only to the server address you set and sends no page content. With the API-key offer on, it reads the page text on your device looking for one key-shaped value, and a matched value leaves the page only after you tap Save.',
])}`)}
${part('09', 'camera', 'Camera and microphone', `<p>The camera is used for one thing: scanning a Wink, the code that pairs or introduces a device, in the Vyre app in a browser or on a phone. It asks for video only, never audio. The picture is read on your device. It is not saved and not sent anywhere. You can also scan a pairing QR code with the phone\'s own camera and it opens the app.</p>
<p>The microphone is not used. The Mac app and the Windows app have no microphone code, the phone app declares no microphone permission, and the browser app never asks for audio.</p>`)}
${part('10', 'passkeys', 'Passkeys and keys', `<p>You make your passkey for your own server's address, with your device's own passkey system. The private key stays in your device's secure hardware or your password manager. Your server keeps only the public half, and Vyre never receives either. The approval key in the phone app is made in secure hardware where the phone has it (the Secure Enclave or the Android Keystore; some phones fall back to software), cannot be exported, and needs your face or fingerprint to use. Your identity has its own recovery code. It is shown to you once; keep it somewhere safe. It restores your identity on a new device.</p>`)}
${part('11', 'push', 'Notifications', `<p>A notification carries a fixed sentence, such as "A session is waiting for your answer", "A milestone is done" or "A teammate finished", and a link to an item by its id. That is all. It carries no thread text, no goal or milestone text, no message text, no teammate name and no project name. The phone opens the item and asks your own server for the details, over your own connection. The fixed sentence does say what kind of thing happened: a question, an approval or a finished goal.</p>
<p>One setting is an exception, and it is off by default: <em>Show a reminder\'s own words on the lock screen</em>. When you turn it on, the label you typed on a reminder rides in that notification and passes through Apple\'s, Google\'s or Mozilla\'s push service. The setting says so.</p>
<p>Notifications work today through Web Push in a browser or on a Home Screen web app. Web Push encrypts the payload end to end and delivers it through your browser\'s push service (Google, Mozilla, Apple or Microsoft), which still sees that a notification was sent to a device, and when. The phone app has no notifications in this version.</p>`)}
${part('12', 'crash', 'Crash logs and diagnostics', `<p>Vyre sends no crash reports and no diagnostics anywhere. Your server writes a log file for each day on your own machine, and <code>vyre doctor</code> prints its checks to your own screen. If something breaks, you decide whether to share a log, for example in a GitHub issue. Your phone's operating system may send its own crash reports to Apple or Google if you turned that on in system settings; that is theirs, not Vyre's.</p>`)}
${part('13', 'delete', 'Delete everything', `${ul([
  '<b>On your server:</b> If you want a copy of your data, run <code>vyre backup</code> and copy the file off the server, because it is saved inside the volume the uninstall deletes. Then run <code>vyre uninstall --delete-data</code>, which stops Vyre, removes its images and deletes its data volumes for good. Finally remove the install folder (<code>/srv/vyre</code>, or your <code>VYRE_DIR</code>; the uninstall prints it) and <code>/var/lib/vyre-update</code>, where automatic updates keep their backups.',
  '<b>On a Mac that runs Vyre as a server,</b> run the installer\'s <code>--uninstall --purge</code> (<code>scripts/install-mac-server.sh</code>), which removes the service, <code>~/.vyre-server</code>, <code>~/.vyre</code> and the system data. Delete <code>~/Vyre/projects</code> if you used it, and remove the <code>vyre-vault</code> and <code>sh.vyre.capsule.presence</code> items in Keychain Access.',
  '<b>On a phone:</b> remove it in Devices on your server first, so its keys stop working. Signing out in the phone app ends your session when the phone can reach your server and forgets the sign-in on the phone, but the phone stays paired. Deleting the app removes its keys on Android; on iPhone the system may keep them.',
  '<b>On a Mac with the Vyre app:</b> drag Vyre from Applications to the Bin, then remove <code>sh.vyre.capsule.presence</code> in Keychain Access. If you also ran Vyre as a server on this Mac, delete <code>~/.vyre</code> too. <b>On Windows:</b> uninstall Vyre in Windows Settings, delete the <code>run.vyre.app</code> folder in <code>%APPDATA%</code> (the pairing file and key), and delete the scheduled task named Vyre in Task Scheduler, or turn off start at sign-in before you uninstall.',
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found: Vyre</title><meta name="robots" content="noindex"><meta name="theme-color" content="#F4F1EA" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0E0D0C" media="(prefers-color-scheme: dark)"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta name="color-scheme" content="light dark">
${FONT_PRELOAD}<link rel="stylesheet" href="${CSS_V}"><script>document.documentElement.className='js'</script><script src="${JS_V}" defer></script></head>
<body>${nav('404')}<main id="main" class="nf"><div class="wrap nf-grid">
  <div class="nf-art" aria-hidden="true">${vmark('nf', 'assemble', 'data-spread="far" data-adrift="14"')}</div>
  <div class="nf-copy">
    <p class="lbl">404 &middot; Needs a person</p>
    <h1 class="display">Nothing is here, <b>and no agent made something up.</b></h1>
    <p class="lead">The address you followed holds no page. Vyre keeps a missing thing missing, so nobody guessed one for you. The dots are finding their way back to the V; you can pick the way yourself.</p>
    <div class="nf-card" role="group" aria-label="Where to go">
      <div class="nf-head"><b>Pick where to go</b><span class="pill acc">&#9679; Needs you</span></div>
      <ul class="nf-links">
        <li><a href="/"><b>Home</b><span>What Vyre is and what you get in ${VERSION}</span></a></li>
        <li><a href="/architecture/"><b>Architecture</b><span>The layers, and how a call and an agent turn flow</span></a></li>
        <li><a href="/start/"><b>Set up Vyre</b><span>Reserve your name and install, step by step</span></a></li>
        <li><a href="/downloads/"><b>Downloads</b><span>Mac, Windows, Android, iPhone, Linux and the web app</span></a></li>
        <li><a href="${REPO}/tree/main/docs"><b>Docs on GitHub</b><span>The plain Markdown, for people and AI agents</span></a></li>
        <li><a href="${MAP_URL}"><b>Point your AI agent at the repo</b><span>Map your business onto Vyre</span></a></li>
        <li><a href="/direction/"><b>Roadmap</b><span>Where Vyre is going, with no dates promised</span></a></li>
        <li><a href="${REPO}/releases/latest"><b>Release notes</b><span>What changed in the latest release</span></a></li>
        <li><a href="${REPO}"><b>Star on GitHub</b><span>Free, open source, Apache 2.0</span></a></li>
      </ul>
    </div>
  </div>
</div></main>${FOOT}</body></html>
`;
  writeFileSync(join(site, '404.html'), html404);
}

// ---------- machine-readable files ----------
const list2 = (arr) => arr.map((x) => `- ${x}`).join('\n');
const SUMMARY = 'Vyre is the agentic command center for AI-native teams. Our mission is to help every professional services team become AI-native. People and agents share chats, records, tasks, files and automations (Flows) on a server the team owns, and anything that leaves the team waits for a person\'s yes. Open source (Apache 2.0), self-hosted, any model: Claude, Codex, Grok and OpenRouter through your own subscriptions or keys. Reach it from the Vyre app on a Mac, on Windows, on a phone, or in a browser.';

const LLMS = `# Vyre

> ${SUMMARY}

Current release: ${VERSION}. Site: ${SITE}. Source: https://github.com/vyre-ai/vyre. Licence: Apache 2.0. Vyre is free; you pay your AI providers directly.

## Start here
- [Home](${SITE}/): what Vyre is and what it does
- [Get started](${SITE}/start/): the steps, from the Vyre app to pairing your server
- [Architecture](${SITE}/architecture/): how Vyre is built, on one page: layers, how a call flows, how an agent\'s turn runs, the Gate
- [Direction](${SITE}/direction/): where Vyre is going (direction, not a promise of dates)
- [Privacy](${SITE}/privacy/): what Vyre knows about you, which is almost nothing

## Devices
- [Downloads](${SITE}/downloads/): every Vyre download in one place, from the latest release
- [Mac: Vyre](${SITE}/mac/): the Vyre app in its own window
- [Windows: Vyre](${SITE}/windows/): tray app with an Alt+Space panel
- [Linux server](${SITE}/linux/): where Vyre runs
- [Phone](${SITE}/phone/): the Vyre app, sideloaded on Android (APK) or iPhone (Xcode)

## Machine-readable
- [llms-full.txt](${SITE}/llms-full.txt): the same content in full
- [agents.md](${SITE}/agents.md): guidance for AI agents that install or operate Vyre
- [sitemap.xml](${SITE}/sitemap.xml)
- [GitHub](https://github.com/vyre-ai/vyre)
- [Map your business onto Vyre](${MAP_URL}): a method an AI agent follows to turn a business into members, records, Flows, agents and Gate rules
`;

const FULL = `# Vyre, in full

${SUMMARY}

Release ${VERSION}. Updated ${MODIFIED}. Source: https://github.com/vyre-ai/vyre. Licence: Apache 2.0.

## What it is
- People and agents in the same chats. @ a teammate or an agent, # a record, a file or a project. Anyone in the Space can make an agent and share it with a person or a role as use-only or full.
- Agents wake on a task and finish it: the agent ends the task as done, hands it on, or marks it stuck with a plain reason. Each agent and each project has an AGENTS.md instructions file.
- One group chat across providers. Claude, Codex, Grok and OpenRouter answer in the same chat through the sign-ins and keys you add. Give agents different jobs: a team that does the work, one model that reviews, one that plans.
- Flows run the same way every time. A trigger (a person, a schedule with business hours and holidays, a record change, a stage, a form, a link or a watcher), then steps: find, create, update, find-or-create, wait for a time, a date or an event, ask, assign, call a connected service, run an agent. A person approves a Flow before it runs, and each run has its own page.
- Playbooks are project templates: stages, the tasks in each stage, who does each task, and when a stage counts as done. Each kind of work can run as its own track, with its own Playbook and Flows over shared records.
- Records: contacts, projects, tasks and your own record types, with fields in named groups, tags, saved views, Excel or CSV import, and CSV export from the web app. Fields marked sealed show an agent a placeholder, never the value.
- Documents fill your own Word templates from a record and the records linked to it, as Word or PDF. Signing sends a document for signature from a record; the signer needs no account, and the signed copy files back on the record.
- Files: one Files place for the Space, with linked Google Drive and Dropbox folders read through each person's own account.
- The Vault holds passwords, API keys, logins with one-time codes, cards, notes and SSH keys, in groups, shared as Can use or Can edit. Agents use a credential without seeing it.
- Sites: an agent builds a site, previews it at a private address, and puts it live on one yes from you.
- Needs you is one place for approvals, asks and stuck tasks. Teams get roles, per-project seat levels and invites with a role.
- Everything that leaves your server (an email, a payment, a deletion, a published page) waits at the Gate for a person to approve the exact words. An agent can ask and cannot approve.
- Architecture: see ${SITE}/architecture/ and https://github.com/vyre-ai/vyre/blob/main/ARCHITECTURE.md.

## Where it runs
- Server: Linux with Docker Compose 2.24 or newer, or a Mac that stays on. Installed in /srv/vyre by one line, curl -fsSL vyre.run/i | sh, which the Vyre app shows. Images are pulled by digest after their signatures are checked. Updates are signed with a pinned key; a box refuses unsigned, tampered or older releases. Stable never takes a prerelease.
- Mac: the Vyre app in its own window, from the GitHub release (Vyre-aarch64.dmg or Vyre-x86_64.dmg). Not yet signed with an Apple Developer ID, so it opens once with Open Anyway. Needs macOS 14 or newer.
- Windows: Vyre, a tray app with an Alt+Space panel, installed with VyreSetup.exe from the GitHub release. Not Authenticode-signed yet, so Windows asks for "More info", then "Run anyway". Pairs with 13 words or a QR code. The server does not run on Windows yet.
- Phone: the Vyre app, sideloaded (the Android APK from the release, or an iPhone build installed with Xcode), paired by scanning a code, with Face ID or a fingerprint. A removed phone wipes itself.
- Network: built in. Nothing to install or sign in to; the relay carries a connection when a direct path is not possible.

## Install
1. Reserve your name at ${SITE}/setup/ and copy the code it shows.
2. Install the app from https://github.com/vyre-ai/vyre/releases/latest: Vyre-aarch64.dmg or Vyre-x86_64.dmg on a Mac, VyreSetup.exe on Windows. Both are sideloaded (not signed with a store identity yet).
3. Open the app, paste the code and save the recovery code.
4. Choose Join a team, Add a server (a Linux machine, or a Mac that stays on; With Records is recommended) or, on a Mac, Use My Home.
5. To add a server, run the one line the app shows on it, as yourself: \`curl -fsSL https://vyre.run/i | VYRE_CODE=<code from the app> sh\`. Confirm the four words in the app.
6. Add your phone from the app: Vyre-android.apk from the release on Android (sideloaded); iPhone has no App Store app yet.

## What it costs
Vyre is free and open source. You pay your AI providers (Claude, Codex, Grok, OpenRouter) on your own subscriptions or keys. Your data lives on your devices and on servers you or your team run. Vyre doesn't hold it.

## Where your data lives
Records, chats, files and the vault stay on your server and your computers. vyre.run holds your name's DNS record and runs the relay (relay.vyre.run), which carries phone pairing, end-to-end encrypted. Prompts go to your AI provider the way they would from that provider's own app.

## Releases
${RELEASE_LINE ? '- ' + RELEASE_LINE : ''}

## Direction (not a promise of dates)
- Now, 0.5: the features above.
- Next, 0.5.1: one chat per Flow, deadlines on agent steps, a failure panel on every step, per-record privacy for custom record types, Flow email with CC, BCC and attachments, an audit screen for admins.
- After that, 0.5.2: Integrations (Clio, Lawmatics, GoHighLevel and DecisionVault are planned), a Skills screen and a Plugins screen.
- Later: Screen Share (watch and take over your agents' computers and Chrome, on every device).
- Later: a Vyre-hosted home for people without a server.

## Known gaps in ${VERSION}
- A member can read every row of a record type the Space defined itself; per-record privacy for custom types is planned for 0.5.1.
- An agent step has no deadline yet. A session that ends without finishing is marked stuck.
- A Flow email cannot yet carry CC, BCC or attachments.
- CSV export is in the web app; a phone does not offer it yet.
- The Mac and Windows apps are not signed with a store identity yet, and the iPhone app is built from source.
See https://github.com/vyre-ai/vyre/blob/main/docs/known-gaps.md.

## FAQ
${HOME_FAQ.map(([q, a]) => `### ${q}\n${strip(a)}`).join('\n\n')}
`;

const AGENTS = `# agents.md: for AI agents that read vyre.run

Vyre is the agentic command center for AI-native teams: open source, self-hosted, run on machines the user owns. This file says what you can do with this site and what you must not do.

## What you can do
- Read any page and the machine-readable files: ${SITE}/llms.txt, ${SITE}/llms-full.txt, ${SITE}/sitemap.xml.
- Tell the user how to install: send them to ${SITE}/start/. The Vyre app shows the user one install line. The user runs it on their own server.
- Answer questions about devices (${SITE}/mac/, ${SITE}/windows/, ${SITE}/linux/, ${SITE}/phone/) the architecture (${SITE}/architecture/) and direction (${SITE}/direction/). Direction is not a promise of dates.
- Follow https://github.com/vyre-ai/vyre/blob/main/docs/for-agents/MAP-YOUR-BUSINESS.md to show a user how their business would run on Vyre.
- Read the source at https://github.com/vyre-ai/vyre. It is Apache 2.0.

## What you must not do
- Do not run the install line, or anything with a pairing code in it, for the user. The code belongs to the user, works once, and is entered in their Vyre app.
- Do not ask the user to paste secrets, vault values, recovery codes or setup codes into a chat.
- Do not claim Vyre runs a server on Windows, or that a Mac download exists. Check ${SITE}/llms-full.txt for the current gaps.

## Facts to repeat exactly
- Apache 2.0. Free. The user pays their own AI providers.
- Server: Linux with Docker Compose 2.24 or newer, or a Mac that stays on. One space per server. A 4 GB server runs one space; Vyre sizes it for you. 8 GB is comfortable and leaves room to grow.
- Mac app: Vyre, in its own window. Windows app: Vyre, Alt+Space. Phone: the Vyre app, sideloaded.
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
  platforms: { server: ['Linux', 'macOS (a Mac that stays on)'], clients: ['macOS (the Vyre app)', 'Windows (the Vyre app)', 'iOS and Android (the app, sideloaded)'] },
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
const SM = [['/', '1.0'], ['/mac/', '0.8'], ['/windows/', '0.8'], ['/linux/', '0.8'], ['/phone/', '0.8'], ['/downloads/', '0.9'], ['/architecture/', '0.8'], ['/direction/', '0.7'], ['/start/', '0.7'], ['/privacy/', '0.5']];
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SM.map(([p, pr]) => `  <url>\n    <loc>${SITE}${p}</loc>\n    <lastmod>${MODIFIED}</lastmod>\n    <priority>${pr}</priority>\n  </url>`).join('\n')}
</urlset>
`);

// ---------- og cards ----------
if (ogDir) {
  mkdirSync(ogDir, { recursive: true });
  for (const p of pages) {
    const html = `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:'Instrument Sans';font-weight:400 600;src:url(${pathToFileURL(join(site, 'fonts', 'instrument-sans-latin.woff2')).href}) format('woff2')}@font-face{font-family:'JetBrains Mono';font-weight:400 500;src:url(${pathToFileURL(join(site, 'fonts', 'jetbrains-mono-latin.woff2')).href}) format('woff2')}
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
