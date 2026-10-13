// scripts/site/pages.mjs: the 404 and the Downloads page for vyre.run. gen-site.mjs passes in its own helpers (nav, footer, asset URLs),
// so these pages share the site's nav, footer, fonts and tokens. Styles live inline in each page: v2.css is not touched.

const DL = 'https://github.com/vyre-ai/vyre/releases/latest/download';
// The stable asset names, as .github/workflows/release.yml and mac-app.yml publish them on every release.
export const ASSETS = {
  macArm: 'Vyre-aarch64.dmg',
  macIntel: 'Vyre-x86_64.dmg',
  windows: 'VyreSetup.exe',
  android: 'Vyre-android.apk',
};

const NF_CSS = `
.nf2{position:relative;min-height:calc(100vh - 160px);padding:clamp(40px,7vw,88px) 0 clamp(56px,8vw,96px);overflow:hidden}
.nf2 .wrap{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:clamp(28px,5vw,72px);align-items:center}
.nf2 .art{position:relative;aspect-ratio:1/1;width:100%;max-width:460px;justify-self:center;background:#0E0D0C;border:1px solid var(--line-2);border-radius:0;clip-path:none;overflow:visible}
.nf2 .art::after{content:"";position:absolute;top:-1px;right:-1px;width:44px;height:44px;pointer-events:none;background:linear-gradient(225deg,var(--bg) 0 48.5%,var(--line-2) 48.5% 51.5%,transparent 51.5%)}
.nf2 canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.nf2 .lbl{margin:0 0 18px;color:var(--accent)}
.nf2 h1.display{font-size:clamp(34px,5.4vw,64px)}
.nf2 .lead{max-width:30em}
.nf2 .btn-row{margin-top:28px}
.needs{margin-top:34px;background:var(--panel);border:1px solid var(--line);max-width:34em}
.needs .nh{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--line);font:500 11px/1.4 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
.needs .nh i{width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block}
.needs ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr}
.needs li{border-top:1px dashed var(--line-2);margin-top:-1px}
.needs li:nth-child(odd){border-right:1px dashed var(--line-2)}
.needs a{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 18px;color:var(--ink);text-decoration:none;font-size:15px;font-weight:500;letter-spacing:-.01em}
.needs a span{color:var(--ink-3);font-weight:400;transition:transform .2s var(--ease)}
.needs a:hover,.needs a:focus-visible{background:var(--accent-wash)}
.needs a:hover span{transform:translateX(3px);color:var(--accent)}
@media (max-width:820px){.nf2 .wrap{grid-template-columns:1fr}.nf2 .art{max-width:300px;order:-1}}
@media (max-width:480px){.needs ul{grid-template-columns:1fr}.needs li:nth-child(odd){border-right:0}}
@media (prefers-reduced-motion:reduce){.needs a span{transition:none}}
`;

// The halftone V, drawn from the same stroke as the site mark. Every dot starts scattered and drifts home; reduced motion draws it home.
const NF_JS = `(function(){
var c=document.getElementById('lost'),reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;if(!c)return;
var S=96,off=document.createElement('canvas');off.width=off.height=S;var o=off.getContext('2d'),k=S/24*.78,ox=(S-24*k)/2+1.2*k,oy=(S-24*k)/2+.6*k;
o.translate(ox,oy);o.scale(k,k);o.strokeStyle='#fff';o.fillStyle='#fff';o.lineWidth=2.6;o.lineCap='round';o.lineJoin='round';
o.beginPath();o.moveTo(3.5,5.5);o.lineTo(12,19.5);o.lineTo(17.96,9.69);o.stroke();o.beginPath();o.arc(20.5,5.5,2.3,0,7);o.fill();
var data=o.getImageData(0,0,S,S).data,n=56,dots=[],seed=7;
function rnd(){seed=(seed*16807)%2147483647;return seed/2147483647}
for(var j=0;j<n;j++)for(var i=0;i<n;i++){var sx=Math.floor((i+.5)/n*S),sy=Math.floor((j+.5)/n*S),v=data[(sy*S+sx)*4+3]/255;
if(v>.2)dots.push({hx:(i+.5)/n,hy:(j+.5)/n,r:Math.pow(v,.8),sx:rnd(),sy:rnd(),dl:rnd()*.35,acc:i>n*.74&&j<n*.34})}
function fit(){var d=Math.min(2,devicePixelRatio||1),w=c.clientWidth,h=c.clientHeight;c.width=w*d;c.height=h*d;var x=c.getContext('2d');x.setTransform(d,0,0,d,0,0);return{x:x,w:w,h:h}}
var g=fit(),t0=null,DUR=3200;
function ease(p){return 1-Math.pow(1-p,3)}
function draw(p,t){var x=g.x,w=g.w,cell=w/n;x.clearRect(0,0,g.w,g.h);
dots.forEach(function(d){var q=Math.max(0,Math.min(1,(p-d.dl)/(1-d.dl))),e=ease(q),
wob=(1-e)*Math.sin(t/420+d.sx*40)*.015;
var px=(d.sx+(d.hx-d.sx)*e+wob)*w,py=(d.sy+(d.hy-d.sy)*e+wob)*g.h,r=cell*.5*(.28+.72*d.r)*(.5+.5*e)*(.88+.12*Math.sin(t/900+d.hy*9));
x.fillStyle=d.acc?'#B8A4FF':'#F1EEE6';x.globalAlpha=.35+.65*e;x.beginPath();x.arc(px,py,Math.max(.4,r),0,6.2832);x.fill()});x.globalAlpha=1}
if(reduce){draw(1,0);addEventListener('resize',function(){g=fit();draw(1,0)});return}
var vis=true;if('IntersectionObserver' in window)new IntersectionObserver(function(es){vis=es[0].isIntersecting}).observe(c);
(function tick(t){if(t0===null)t0=t;if(vis)draw(Math.min(1,(t-t0)/DUR),t);requestAnimationFrame(tick)})(0);
addEventListener('resize',function(){g=fit()});
})();`;

export function page404(ctx) {
  const { nav, FOOT, FONT_PRELOAD, CSS_V, JS_V, REPO, SITE } = ctx;
  const links = [
    ['Home', '/'],
    ['Architecture', '/architecture/'],
    ['Set up Vyre', '/start/'],
    ['Downloads', '/downloads/'],
    ['Docs', `${REPO}/tree/main/docs`],
    ['Point your agent', '/agenthome'],
    ['Roadmap', '/direction/'],
    ['Release notes', `${REPO}/releases`],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found: Vyre</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta name="color-scheme" content="light dark">
${FONT_PRELOAD}<link rel="stylesheet" href="${CSS_V}"><style>${NF_CSS}</style><script>document.documentElement.className='js'</script><script src="${JS_V}" defer></script></head>
<body>${nav('404')}<main id="main" class="nf2"><div class="wrap">
<div>
<p class="lbl">404 &middot; Page not found</p>
<h1 class="display">No agent could find this page, <b>and none of them guessed.</b></h1>
<p class="lead">The page may have moved, or the link may be wrong. Here is where the real ones are.</p>
<div class="btn-row"><a class="btn btn-fill" href="/">Back to vyre.run</a><a class="btn" href="${REPO}">${ctx.STAR}Star on GitHub</a></div>
<div class="needs" role="group" aria-label="Where to go"><p class="nh"><i aria-hidden="true"></i>Needs you</p><ul>${links.map(([t, h]) => `<li><a href="${h}">${t}<span aria-hidden="true">&rarr;</span></a></li>`).join('')}</ul></div>
</div>
<div class="art" role="img" aria-label="The Vyre mark, drawn in dots, drifting back into place."><canvas id="lost"></canvas></div>
</div></main>${FOOT}<script>${NF_JS}</script></body></html>
`;
}

const DL_CSS = `
.dl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:0;border:1px solid var(--line);background:var(--panel)}
.dl-card{padding:24px 22px 22px;border-left:1px solid var(--line);border-top:1px solid var(--line);margin:-1px 0 0 -1px;display:flex;flex-direction:column;gap:6px}
.dl-card h3{margin:0;font-size:20px;font-weight:600;letter-spacing:-.02em}
.dl-card .lbl{margin:0 0 2px}
.dl-card p{margin:0;color:var(--ink-2);font-size:15px}
.dl-card .btn-row{margin-top:auto;padding-top:16px}
.dl-card .file{font:400 12px/1.4 var(--mono);color:var(--ink-3);overflow-wrap:anywhere}
.dl-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:clamp(24px,4vw,56px)}
.dl-two h3{margin:0 0 6px;font-size:20px;font-weight:600;letter-spacing:-.02em}
.dl-two p{color:var(--ink-2);font-size:15px;margin:0 0 6px}
.dl-steps{margin:8px 0 0;padding-left:1.2em;color:var(--ink-2);font-size:15px}
.dl-steps li{margin:.4em 0}
.dl-sub{margin:40px 0 0;display:flex;flex-wrap:wrap;gap:8px 20px;font-size:15px;color:var(--ink-2)}
`;

export function downloadsPage(ctx) {
  const { VERSION, REPO, term, eyebrow } = ctx;
  const card = (label, title, text, file, href, btn = 'Download') => `<div class="dl-card rv"><p class="lbl">${label}</p><h3>${title}</h3><p>${text}</p><p class="file">${file}</p><div class="btn-row"><a class="btn btn-fill btn-sm" href="${href}" download>${btn}</a></div></div>`;
  const webCard = `<div class="dl-card rv"><p class="lbl">Browser</p><h3>Web app</h3><p>Open Vyre at your own address, such as you.vyre.run, from any browser. Add it to your Home Screen on a phone.</p><p class="file">no install</p><div class="btn-row"><a class="btn btn-fill btn-sm" href="https://web.vyre.run">Open web app</a></div></div>`;
  const body = `<style>${DL_CSS}</style>
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Downloads</p>
    ${eyebrow('Vyre ' + VERSION)}
    <h1 class="display">Get Vyre <b>on every device.</b></h1>
    <p class="lead">The Vyre app for your Mac, your Windows PC and your phone, the one line that puts a server on Linux or on a Mac that stays on, and the web app. Every file comes from the latest release on GitHub.</p>
    <div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="${REPO}/releases/latest">All files on GitHub</a></div>
  </div>
</section>
<section class="sec" aria-labelledby="apps-h">
  <div class="wrap">
    <div class="sec-head rv"><h2 id="apps-h" class="h2">The Vyre <b>app.</b></h2></div>
    <div class="dl-grid">
      ${card('Mac', 'Apple silicon', 'For a Mac with an M-series chip. Open the dmg and drag Vyre to Applications.', ASSETS.macArm, `${DL}/${ASSETS.macArm}`)}
      ${card('Mac', 'Intel', 'For a Mac with an Intel chip. Open the dmg and drag Vyre to Applications.', ASSETS.macIntel, `${DL}/${ASSETS.macIntel}`)}
      ${card('Windows', 'Windows installer', 'A tray app with an Alt+Space panel. Run the installer; Windows may ask you to confirm it.', ASSETS.windows, `${DL}/${ASSETS.windows}`)}
      ${card('Android', 'Android APK', 'Open the file on the phone and allow installs from your browser or Files app when Android asks.', ASSETS.android, `${DL}/${ASSETS.android}`)}
      <div class="dl-card rv"><p class="lbl">iPhone</p><h3>Install with Xcode</h3><p>There is no App Store app yet. Build the app and install it on your phone with Xcode.</p><p class="file">sideloaded</p><div class="btn-row"><a class="btn btn-fill btn-sm" href="/docs/using/mobile">Read the steps</a></div></div>
      ${webCard}
    </div>
    <p class="dl-sub"><span>More on each device:</span><a href="/mac/">Mac</a><a href="/windows/">Windows</a><a href="/phone/">Phone</a><a href="/linux/">Linux server</a></p>
  </div>
</section>
<section class="sec" aria-labelledby="srv-h">
  <div class="wrap">
    <div class="sec-head rv"><h2 id="srv-h" class="h2">Put the server <b>on a machine you own.</b></h2></div>
    <div class="dl-two">
      <div class="rv"><h3>Linux server</h3><p>A Linux machine you can reach with sudo. Run the line as yourself, not as root. The installer asks before it adds anything.</p>${term('curl -fsSL vyre.run/i | sh')}<p><a href="/linux/">Read the Linux server page</a></p></div>
      <div class="rv"><h3>A Mac that stays on</h3><p>Run this line in Terminal on that Mac. It asks for the Mac's password once so Vyre can start when the Mac starts.</p>${term('curl -fsSL vyre.run/box/install-mac-server.sh | sh')}<p><a href="/mac/">Read the Mac page</a></p></div>
    </div>
  </div>
</section>
<section class="sec" aria-labelledby="sig-h">
  <div class="wrap">
    <div class="note rv"><p class="lbl" id="sig-h" style="margin-bottom:8px">Signatures</p><p style="margin:0">Each release is signed with the Vyre release key, and the app and the server install check that signature before they update. The signature files and the full list of files for this version are on the <a href="${REPO}/releases/latest">release page</a>.</p></div>
  </div>
</section>
<section class="closing" aria-labelledby="end-h"><div class="wrap"><h2 id="end-h" class="display">Install it, <b>then pair it.</b></h2><div class="btn-row"><a class="btn btn-fill" href="/start/">Set up Vyre</a><a class="btn" href="/">Back to vyre.run</a></div></div></section>`;
  return {
    slug: 'downloads', path: '/downloads/',
    title: 'Download Vyre: Mac, Windows, Android, iPhone, Linux server',
    desc: 'Download the Vyre app for Mac, Windows and Android, install on iPhone, put the server on Linux or a Mac with one line, or open the web app.',
    ogTitle: 'Get Vyre on every device.', ogSub: 'Mac, Windows, phone, a Linux server, and the web app.',
    body,
  };
}
