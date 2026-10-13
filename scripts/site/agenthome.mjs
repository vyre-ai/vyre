// /agenthome (readable HTML) and /agenthome.md (raw Markdown), both generated from docs/for-agents/START-HERE.md, the one source.
// Plain, semantic HTML with the full instructions as real text: no script is needed to read it.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Bare URLs become links. A URL ends before a space, a closing tag or trailing punctuation.
  s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<]+?)([.,:;)]*)(?=$|\s|<)/g, (_, pre, url, tail) => `${pre}<a href="${url}">${url}</a>${tail}`);
  return s;
}

export function stripFrontmatter(md) { return md.replace(/^---\n[\s\S]*?\n---\n/, ''); }

export function mdToHtml(md) {
  const lines = stripFrontmatter(md).split('\n');
  const out = [];
  let i = 0, id = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,3}) (.*)$/.exec(l))) {
      const n = m[1].length, slug = m[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `s${++id}`;
      out.push(`<h${n} id="${slug}">${inline(m[2])}</h${n}>`); i++; continue;
    }
    if (/^- /.test(l)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) { items.push(`<li>${inline(lines[i].slice(2))}</li>`); i++; }
      out.push(`<ul>${items.join('')}</ul>`); continue;
    }
    if (/^\d+\. /.test(l)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\d+\. /, ''))}</li>`); i++; }
      out.push(`<ol>${items.join('')}</ol>`); continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3} |- |\d+\. )/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

const STYLE = `<style>
.prose{max-width:760px;margin:0 auto}
.prose h1{font-weight:600;font-size:clamp(32px,5vw,52px);line-height:1.08;letter-spacing:-.03em;margin:0 0 20px}
.prose h2{font-weight:600;font-size:clamp(22px,2.8vw,30px);letter-spacing:-.02em;margin:48px 0 12px;padding-top:24px;border-top:1px dashed var(--line-2)}
.prose p,.prose li{font-size:16.5px;line-height:1.65;color:var(--ink-2)}
.prose li{margin:.35em 0}
.prose strong{color:var(--ink)}
.prose a{overflow-wrap:anywhere}
.prose .twin{font:400 13px var(--mono);color:var(--ink-3);margin:0 0 28px}
</style>`;

export const AGENTHOME_META = {
  slug: 'agenthome', path: '/agenthome/',
  title: 'Start here, for AI agents: how a business runs on Vyre',
  desc: 'The entry point for an AI agent: what Vyre is, a map of the site and docs, how to map a business onto Vyre, and how to help set it up today.',
  ogTitle: 'Start here, for AI agents.', ogSub: 'Map a business onto Vyre, then set it up.',
};

export function agentHomeBody(md) {
  return `${STYLE}
<section class="sec" style="padding-top:clamp(40px,6vw,72px)">
  <div class="wrap">
    <article class="prose" aria-label="Instructions for AI agents">
      <p class="twin">The same text as Markdown: <a href="/agenthome.md">https://vyre.run/agenthome.md</a></p>
${mdToHtml(md)}
    </article>
  </div>
</section>`;
}
