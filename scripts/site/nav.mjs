// The site header: brand, grouped mega-menu panels, GitHub, Log in and one primary button.
// Plain links without script (the panels open on hover or focus); v2.js adds click, hover intent and Escape.
const g = (d) => `<svg class="mi-svg" width="18" height="18" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const P = {
  records: '<rect x="4" y="5" width="20" height="18" rx="1.8"/><path d="M4 11h20M4 17h20M11 5v18"/>',
  flows: '<circle cx="7" cy="8" r="2.6"/><circle cx="21" cy="8" r="2.6"/><circle cx="14" cy="21" r="2.6"/><path d="M9.6 8h8.8M8.4 10.3l4.2 8.4M19.6 10.3l-4.2 8.4"/>',
  agents: '<circle cx="9" cy="10" r="3.2"/><circle cx="19" cy="10" r="3.2"/><path d="M3.5 22c.6-3.6 2.8-5.4 5.5-5.4s4.9 1.8 5.5 5.4M13.5 22c.6-3.6 2.8-5.4 5.5-5.4s4.9 1.8 5.5 5.4"/>',
  vault: '<rect x="5" y="12" width="18" height="11" rx="2"/><path d="M9 12V9a5 5 0 0 1 10 0v3M14 16.5v3"/>',
  computer: '<rect x="3.5" y="5" width="21" height="14" rx="2"/><path d="M10 23h8M14 19v4"/>',
  arch: '<rect x="4" y="12" width="9" height="9" rx="1.4"/><rect x="15" y="12" width="9" height="9" rx="1.4"/><rect x="9.5" y="4" width="9" height="9" rx="1.4"/>',
  law: '<path d="M4 10l10-6 10 6M6.5 12v8M11 12v8M17 12v8M21.5 12v8M4 23h20"/>',
  acct: '<rect x="6" y="3.5" width="16" height="21" rx="2"/><path d="M10 8.5h8M10.5 13h.01M14 13h.01M17.5 13h.01M10.5 17h.01M14 17h.01M17.5 17h.01"/>',
  cons: '<path d="M4 23h20M7 23v-8M12 23V9M17 23v-6M22 23V5"/>',
  mkt: '<path d="M5 11v6h4l9 5V6L9 11z"/><path d="M21.5 10.5a5 5 0 0 1 0 7"/>',
  home: '<path d="M4 13L14 4l10 9M7 11.5V23h14V11.5M12 23v-6h4v6"/>',
  cmp: '<rect x="3.5" y="8" width="6" height="12" rx="1.2"/><rect x="11" y="8" width="6" height="12" rx="1.2"/><rect x="18.5" y="8" width="6" height="12" rx="1.2"/>',
  map: '<circle cx="7" cy="20" r="2.5"/><circle cx="21" cy="8" r="2.5"/><path d="M9.5 20H16a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6.5"/>',
  doc: '<path d="M7 3.5h10l5 5v16H7z"/><path d="M17 3.5v5h5M10.5 13h8M10.5 17h8M10.5 21h4"/>',
  down: '<path d="M14 4v14M8 12l6 6 6-6M5 23h18"/>',
  dir: '<circle cx="14" cy="14" r="9.5"/><path d="M18.5 9.5l-2.2 6.8-6.8 2.2 2.2-6.8z"/>',
  mail: '<rect x="4" y="6.5" width="20" height="15" rx="2"/><path d="M4.5 8l9.5 7 9.5-7"/>',
  oss: '<circle cx="8" cy="7" r="2.5"/><circle cx="8" cy="21" r="2.5"/><circle cx="20" cy="11" r="2.5"/><path d="M8 9.5v9M20 13.5c0 4-12 2-12 5"/>',
};
const GH = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

// Every existing top-level and menu URL stays reachable: /#product and /#open are the "Overview" and "Open source" links.
export const GROUPS = [
  { t: 'Product', h: '/#product', id: 'pn-product',
    cols: [
      { h: 'Build', items: [['Records', '/records/', 'records', 'Custom tables with links, stages and views'], ['Flows', '/flows/', 'flows', 'Triggered steps, with approval before anything leaves'], ['Agents', '/agents/', 'agents', 'AI teammates with their own memory and access']] },
      { h: 'Run', items: [['Vault', '/vault/', 'vault', 'Sealed passwords and keys that agents use without seeing'], ['Vyre Computer', '/computer/', 'computer', 'Agents working in your Chrome and on your Mac'], ['Architecture', '/architecture/', 'arch', 'How the layers fit, from the app to the kernel']] },
    ],
    feat: ['Run Vyre on a server you own', 'The setup steps in order, from your name to your phone.', 'Get started', '/start/'], more: ['Product overview', '/#product'] },
  { t: 'Solutions', h: '/for/', id: 'pn-solutions',
    cols: [
      { h: 'By industry', items: [['Law firms', '/for/law-firms/', 'law', 'Intake, matters, deadlines and signing'], ['Accounting firms', '/for/accounting-firms/', 'acct', 'Onboarding, monthly close and tax season'], ['Consulting firms', '/for/consulting-firms/', 'cons', 'Scoping, proposals and weekly status'], ['Marketing agencies', '/for/marketing-agencies/', 'mkt', 'Briefs, review rounds and client approval'], ['Real estate brokerages', '/for/real-estate-brokerages/', 'home', 'Lead response through to a closed deal']] },
      { h: 'Explore', items: [['Compare', '/compare/', 'cmp', 'How Vyre sits next to the tools you use now'], ['Map your business', '/map/', 'map', 'Get a prompt that maps your firm onto Vyre']] },
    ],
    feat: ['Ask your AI agent how your business runs on Vyre', 'Pick your industry and tools, then copy the prompt.', 'Get the prompt', '/map/'], more: ['All industries', '/for/'], inCol: true },
  { t: 'Resources', h: '/docs/', id: 'pn-resources',
    cols: [
      { h: 'Learn', items: [['Docs', '/docs/', 'doc', 'Guides and reference for every part'], ['Direction and roadmap', '/direction/', 'dir', 'Where Vyre is today and what comes next'], ['Weekly updates', '/updates/', 'mail', 'One short email a week, at most']] },
      { h: 'Get', items: [['Downloads', '/downloads/', 'down', 'Mac, Windows, Android, iPhone and Linux'], ['Agent home', '/agenthome/', 'agents', 'The entry point for an AI agent'], ['Open source', '/#open', 'oss', 'Apache 2.0, in the open on GitHub']] },
    ],
    feat: ['Point your agent at Vyre', 'A map of the site and docs written for an AI agent to read.', 'Open Agent home', '/agenthome/'] },
];

export function buildNav({ slug, MARK, WORD, REPO }) {
  const isCur = (h) => { const seg = h.split('#')[0].split('/')[1]; return !!seg && h.indexOf('#') < 0 && (slug === seg || slug.startsWith(seg + '/')); };
  const cur = (h) => (isCur(h) ? ' aria-current="page"' : '');
  const entry = ([t, h, i, d]) => `<a class="mi" href="${h}"${cur(h)}><span class="mi-ic">${g(P[i])}</span><span class="mi-tx"><b>${t}</b><small>${d}</small></span></a>`;
  const group = (G) => {
    const here = G.cols.some((c) => c.items.some(([, h]) => isCur(h)));
    const [ft, fd, fg, fh] = G.feat;
    const feat = `<a class="pn-feat" href="${fh}"><span class="pn-ft">${ft}</span><span class="pn-fd">${fd}</span><span class="pn-fg">${fg} &rarr;</span></a>`;
    return `<div class="nav-grp"><a class="nav-top" href="${G.h}" aria-controls="${G.id}"${here ? ' aria-current="page"' : ''}>${G.t}<svg class="chev" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`
      + `<div class="nav-pop" id="${G.id}"><div class="pn-cols">${G.cols.map((c, i) => `<div class="pn-col"><p class="pn-h">${c.h}</p>${c.items.map(entry).join('')}${G.inCol && i === 0 ? `<a class="pn-more" href="${G.more[1]}">${G.more[0]} &rarr;</a>` : ''}${G.inCol && i === 1 ? feat : ''}</div>`).join('')}</div>`
      + (G.inCol ? '' : `<div class="pn-foot">${feat}${G.more ? `<a class="pn-more" href="${G.more[1]}">${G.more[0]} &rarr;</a>` : ''}</div>`) + '</div></div>';
  };
  return `<a class="skip" href="#main">Skip to content</a>
<header class="nav">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Vyre, home">${MARK}${WORD}</a>
    <nav class="nav-links" id="links" aria-label="Main">${GROUPS.map(group).join('')}<a class="nav-link" href="/docs/"${cur('/docs/')}>Docs</a><a class="nav-link nav-gh" href="${REPO}">${GH}<span>GitHub</span></a><div class="nav-menu-end"><a class="nav-login" href="https://web.vyre.run">Log in</a><a class="nav-cta" href="/start/">Set up Vyre</a></div></nav>
    <div class="nav-end">
      <a class="nav-login" href="https://web.vyre.run">Log in</a>
      <a class="nav-cta" href="/start/">Set up Vyre</a>
      <button class="icon-btn menu-btn" id="menu" type="button" aria-expanded="false" aria-controls="links" aria-label="Menu"><svg class="m-open" width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 5h12M2 11h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><svg class="m-shut" width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    </div>
  </div>
</header>`;
}
