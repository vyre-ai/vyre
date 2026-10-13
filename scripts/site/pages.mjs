// scripts/site/pages.mjs: the 404 for vyre.run. gen-site.mjs passes in its own helpers (nav, footer, asset URLs, the halftone V),
// so the page shares the site's nav, footer, fonts and tokens. Its styles are the .nf rules in v2.css.

export function page404(ctx) {
  const { nav, FOOT, FONT_PRELOAD, CSS_V, JS_V, REPO, SITE, VERSION, vmark } = ctx;
  const links = [
    ['Home', '/', `What Vyre is and what you get in ${VERSION}`],
    ['Architecture', '/architecture/', 'The layers, and how a call and an agent turn flow'],
    ['Set up Vyre', '/start/', 'Reserve your name and install, step by step'],
    ['Downloads', '/downloads/', 'Mac, Windows, Android, iPhone, Linux and the web app'],
    ['Docs', '/docs/', 'The docs, and the plain Markdown for people and AI agents'],
    ['Point your agent', '/agenthome/', 'Let your AI agent map your business onto Vyre'],
    ['Roadmap', '/direction/', 'Where Vyre is going, with no dates promised'],
    ['Release notes', `${REPO}/releases/latest`, 'What changed in the latest release'],
    ['Star on GitHub', REPO, 'Free, open source, Apache 2.0'],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found: Vyre</title><meta name="robots" content="noindex"><meta name="theme-color" content="#F4F1EA" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0E0D0C" media="(prefers-color-scheme: dark)"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta name="color-scheme" content="light dark">
${FONT_PRELOAD}<link rel="stylesheet" href="${CSS_V}"><script>document.documentElement.className='js'</script><script src="${JS_V}" defer></script></head>
<body>${nav('404')}<main id="main" class="nf"><div class="wrap nf-grid">
  <div class="nf-art" aria-hidden="true">${vmark('nf', 'assemble', 'data-spread="far" data-adrift="14"')}</div>
  <div class="nf-copy">
    <p class="lbl">404 &middot; Needs a person</p>
    <h1 class="display">No agent could find this page, <b>and none of them guessed.</b></h1>
    <p class="lead">The page may have moved, or the link may be wrong. The dots are finding their way back to the V; you can pick the way yourself.</p>
    <div class="nf-card" role="group" aria-label="Where to go">
      <div class="nf-head"><b>Pick where to go</b><span class="pill acc">&#9679; Needs you</span></div>
      <ul class="nf-links">
${links.map(([t, h, d]) => `        <li><a href="${h}"><b>${t}</b><span>${d}</span></a></li>`).join('\n')}
      </ul>
    </div>
  </div>
</div></main>${FOOT}</body></html>
`;
}
