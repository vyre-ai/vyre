// scripts/site/updates.mjs: the weekly update signup. The form block (home page, /agenthome and /updates/), the /updates/ page,
// and the privacy paragraphs about what the list keeps. The Worker that takes the post is updates/worker; the promise next to the
// checkbox is its CONSENT_TEXT, so the page and the stored consent_version cannot drift apart (updates/worker/worker.test.js checks it).
import { CONSENT_TEXT } from '../../updates/worker/consent.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The signup form. `id` keeps the field ids unique when a page holds two; `source` is the page path the Worker stores with the row;
 * `compact` is the one-row form for a page footer. Plain HTML: it posts to /api/updates without script and v2.js sends it with fetch.
 */
export function updatesForm({ id = 'upd', source = '/updates/', compact = false } = {}) {
  return `<form class="upd${compact ? ' upd-compact' : ''}" data-upd method="post" action="/api/updates" aria-labelledby="${id}-t">
  <p class="upd-t" id="${id}-t">${compact ? 'The weekly update' : 'Get the weekly update'}</p>
  <div class="upd-row">
    <label class="upd-f" for="${id}-name"><span>Name</span><input id="${id}-name" name="name" type="text" autocomplete="name" required maxlength="80"></label>
    <label class="upd-f" for="${id}-email"><span>Email</span><input id="${id}-email" name="email" type="email" autocomplete="email" required maxlength="254"></label>
    <button class="btn btn-fill" type="submit">Sign up</button>
  </div>
  <div class="upd-hp" aria-hidden="true"><label>Leave this empty<input name="website" type="text" tabindex="-1" autocomplete="off"></label></div>
  <input type="hidden" name="source" value="${esc(source)}">
  <label class="upd-c" for="${id}-consent"><input id="${id}-consent" name="consent" type="checkbox" required><span>${esc(CONSENT_TEXT)}</span></label>
  <p class="upd-s">What the list keeps is on the <a href="/privacy/#updates">privacy page</a>.</p>
  <p class="upd-msg" role="status" aria-live="polite"></p>
</form>`;
}

/** The home page's band above the footer. */
export const updatesBand = () => `<section class="upd-band" aria-label="Weekly update"><div class="wrap">${updatesForm({ id: 'updh', source: '/', compact: true })}</div></section>`;

const link = (href, t, d) => `<li><a href="${href}"><b>${t}</b><span>${d}</span></a></li>`;

export const UPDATES_PAGE = {
  slug: 'updates', path: '/updates/',
  title: 'Weekly update: one email a week from Vyre',
  desc: 'One email a week with what changed in Vyre, at most. Give a name and an email, leave from any email in one click, and read exactly what the list keeps.',
  ogTitle: 'One email a week.', ogSub: 'What changed in Vyre, in one email. Never more.',
  body: `
<section class="phead">
  <div class="wrap">
    <p class="crumbs"><a href="/">Vyre</a> / Weekly update</p>
    <p class="eyebrow">The weekly update.</p>
    <h1 class="display">One email a week. <b>What changed in Vyre.</b></h1>
    <p class="lead">Vyre ships in the open. Each week the project writes down what changed: new releases, what each one does and what comes next. You can get that as one email instead of watching the repository.</p>
  </div>
</section>
<section class="sec" style="padding-top:32px"><div class="wrap upd-page">
  <div class="upd-card">${updatesForm({ id: 'updp', source: '/updates/' })}</div>
  <div class="upd-info">
    <h2 class="upd-h">What you get</h2>
    <ul class="plain">
      <li>One email a week at most, with all of that week's updates in it. Never a second one.</li>
      <li>The same changes that appear in the <a href="https://github.com/vyre-ai/vyre/releases">releases</a> and the <a href="https://github.com/vyre-ai/vyre/blob/main/CHANGELOG.md">changelog</a>, gathered in one place.</li>
      <li>A link in every email that removes you in one click.</li>
    </ul>
    <h2 class="upd-h">What the list keeps</h2>
    <ul class="plain">
      <li>Your name, your email, the time you signed up, the page you signed up on and which version of the promise above you saw.</li>
      <li>It is used for this email and nothing else. It is not shared or sold.</li>
      <li>Leaving deletes the row. The <a href="/privacy/#updates">privacy page</a> has the whole account.</li>
    </ul>
  </div>
</div></section>
<section class="sec" style="padding-top:56px"><div class="wrap">
  <p class="lbl" style="margin-bottom:14px">Connects to</p>
  <ul class="upd-links">
    ${link('/direction/', 'Direction', 'what is built now and what comes next, which the weekly update follows')}
    ${link('https://github.com/vyre-ai/vyre/releases', 'Releases', 'every release, with its signed files')}
    ${link('/privacy/#updates', 'Privacy', 'what the list keeps and how to leave it')}
    ${link('/start/', 'Get started', 'set up Vyre and pair your first device')}
  </ul>
</div></section>`,
};

/** The privacy page's section about the list, as [heading, intro, bullets]. gen-site wraps it in its own part() and ul(). */
export const UPDATES_PRIVACY = {
  heading: 'The weekly update list',
  intro: 'If you sign up for the weekly update, the project keeps a small record so it can email you. Signing up is optional and nothing else on this site asks for your name or email.',
  items: [
    '<b>What it keeps:</b> your name, your email address, the time you signed up, the page you signed up on (for example <code>/updates/</code>) and the version of the promise you saw next to the checkbox. Nothing else.',
    '<b>Why:</b> to send you one email a week at most, with what changed in Vyre. The address is not used for anything else, not shared with anyone and not sold. There is no advertising and no other list.',
    '<b>Where:</b> in a key-value store on the project\'s Cloudflare account. The record is filed under a keyed hash of your address, not the address, and the Worker that saves it writes no log of it. Cloudflare\'s request logs are turned off for that Worker.',
    '<b>Your address while you sign up:</b> the Worker counts requests per address in a 60 second window, so one client cannot flood the form. It does not store the address or write it to a log.',
    '<b>One a week, at most:</b> the promise next to the checkbox is "' + CONSENT_TEXT + '"',
    '<b>How to leave:</b> every email carries an unsubscribe link. Opening it shows a button, and pressing the button deletes your record for good. You can also write to <a href="mailto:privacy@vyre.run">privacy@vyre.run</a> and ask to be removed.',
    '<b>The sending service:</b> the project names the service that sends the email in this section before the first email goes out.',
  ],
};
