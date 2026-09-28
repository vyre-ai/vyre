// vyre.run: copy buttons, install tabs, your own address, the Capsule demo and the small
// interactive panels (memory's Why, vault revoke, Glass take-over, module switches).
// Everything here runs in the page. Nothing you type is sent anywhere.
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // A short message at the bottom of the screen.
  const toast = $('#toast');
  let toastTimer = 0;
  function say(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.remove('on'); toast.textContent = ''; }, 2600);
  }

  // Copy buttons. The label span is [data-copy-label] on /start and .txt on the landing page;
  // an install block's [data-copied] line says it worked.
  $$('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const label = $('[data-copy-label], .txt', btn);
      const ariaLabel = btn.dataset.aria || (btn.dataset.aria = btn.getAttribute('aria-label') || '');
      const block = btn.closest('[data-install]');
      const note = block && $('[data-copied]', block);
      let ok = true;
      try {
        await navigator.clipboard.writeText(btn.getAttribute('data-copy'));
      } catch (e) {
        ok = false;
      }
      if (label) label.textContent = ok ? 'Copied' : 'Select it';
      if (note) note.textContent = ok ? 'Copied to your clipboard.' : 'Copy failed. Select the text and copy it yourself.';
      if (ok) btn.setAttribute('aria-label', 'Copied');
      setTimeout(() => {
        if (label) label.textContent = 'Copy';
        if (note) note.textContent = '';
        if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
      }, 2000);
    });
  });

  // Your name becomes your address everywhere on the page.
  const nameIn = $('#yourname');
  const hosts = $$('[data-host]');
  if (nameIn) {
    nameIn.addEventListener('input', () => {
      const clean = nameIn.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20);
      if (clean !== nameIn.value) nameIn.value = clean;
      const host = (clean || 'yourname') + '.vyre.run';
      hosts.forEach((el) => { el.textContent = host; });
      nameIn.style.width = Math.max(clean.length || 8, 3) + 0.2 + 'ch';
    });
  }

  // Install tabs: Linux server / Mac / What it needs. The hero and the end of the page each have
  // a group. Each tab's id ends in a stable key ("linux", "mac", "needs") shared across both
  // groups; a remembered choice and the OS guess are stored and matched by that key.
  const tabKey = (el) => el.id.split('-').pop();
  const STORE_KEY = 'vyre-install-os';
  const readStored = () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } };
  const writeStored = (key) => { try { localStorage.setItem(STORE_KEY, key); } catch {} };
  // A guess for the default only: a Mac reads as "mac" (checked in both platform and the UA
  // string, since navigator.platform can be frozen or absent), anything else as "linux".
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const guessOs = /mac/i.test(platform) || /mac/i.test(navigator.userAgent || '') ? 'mac' : 'linux';

  $$('.itabs').forEach((tabs) => {
    const tabEls = $$('.itab', tabs);
    const select = (tab, { remember = true } = {}) => {
      tabEls.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      if (remember) writeStored(tabKey(tab));
    };
    tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.itab');
      if (tab) select(tab);
    });
    tabs.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const at = tabEls.indexOf(document.activeElement);
      if (at < 0) return;
      e.preventDefault();
      const next = e.key === 'ArrowLeft' ? Math.max(0, at - 1) : e.key === 'ArrowRight' ? Math.min(tabEls.length - 1, at + 1)
        : e.key === 'Home' ? 0 : tabEls.length - 1;
      tabEls[next].focus();
      select(tabEls[next]);
    });
    // Default: a remembered choice wins, then the OS guess, then the markup's own selection.
    const want = readStored() || guessOs;
    const initial = tabEls.find((t) => tabKey(t) === want);
    if (initial && !initial.matches('[aria-selected="true"]')) select(initial, { remember: false });
  });

  // Memory: "Why?" opens the turn a recalled answer came from.
  $$('.why[aria-controls]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const src = document.getElementById(btn.getAttribute('aria-controls'));
      if (!src) return;
      const open = src.hidden;
      src.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
  });

  // Vault: revoke the shared env set, and share it again.
  $$('[data-share]').forEach((row) => {
    const btn = $('[data-revoke]', row);
    const state = $('[data-share-state]', row);
    const note = $('[data-share-note]', row.parentElement);
    if (!btn || !state) return;
    const was = { state: state.textContent, note: note ? note.textContent : '' };
    btn.addEventListener('click', () => {
      const shared = btn.textContent.trim() === 'Revoke';
      state.textContent = shared ? 'not shared' : was.state;
      btn.textContent = shared ? 'Share again' : 'Revoke';
      btn.setAttribute('aria-label', shared ? 'Share the harlow-site env with Harlow Legal again' : 'Revoke the harlow-site env share');
      if (note) note.textContent = shared ? 'Revoked. Harlow Legal can no longer use harlow-site env, and the values never left your server.' : was.note;
    });
  });

  // Glass: take the keyboard from kit, then hand it back.
  $$('[data-glass]').forEach((glass) => {
    const btn = $('[data-takeover]', glass);
    const who = $('[data-glass-who]', glass);
    const tag = $('[data-glass-tag]', glass);
    const msg = $('[data-glass-msg]', glass);
    if (!btn) return;
    const was = { who: who && who.textContent, tag: tag && tag.textContent, msg: msg && msg.innerHTML };
    btn.addEventListener('click', () => {
      const take = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(take));
      btn.textContent = take ? 'Hand back' : 'Take over';
      glass.classList.toggle('taken', take);
      if (who) who.textContent = take ? 'paused' : was.who;
      if (tag) tag.textContent = take ? 'you' : was.tag;
      if (msg) msg.innerHTML = take ? '<span class="bone">You have the keyboard.</span> kit is paused until you hand it back.' : was.msg;
    });
  });

  // Settings > Modules: the switches flip.
  $$('.sw-btn[role="switch"]').forEach((sw) => {
    sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      say(sw.getAttribute('aria-label') + (on ? ' is on.' : ' is off. The other modules keep working.'));
    });
  });

  // The Capsule demo. One Capsule lives in the hero; the dialog borrows it while open.
  const wrap = $('[data-cap-wrap]');
  const cap = wrap && $('[data-capsule]', wrap);
  if (!cap) return;
  const field = $('.cap-field', cap);
  const reply = $('[data-reply]', cap);
  const status = $('[data-status]', wrap);
  const modes = $$('.cap-modes .dtab', wrap);
  const dest = {
    name: $('[data-d-name]', cap), where: $('[data-d-where]', cap),
    note: $('[data-d-note]', cap), hint: $('[data-d-hint]', cap),
  };
  const DEFAULT_HINT = dest.hint ? dest.hint.textContent : '';
  // Where a message goes, by the @name at its start. No @name means juno, your assistant.
  const ROUTES = {
    juno: ['juno', 'your assistant', 'default'],
    kit: ['kit', 'Harlow Legal › Q3 report', 'thread'],
    northwind: ['kit', 'Northwind Bakery › order form', 'project'],
  };

  function setState(state) {
    cap.setAttribute('data-state', state);
    modes.forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-state') === state)));
  }
  function setStatus(text) { if (status) status.textContent = text; }

  function routeFor(text) {
    const m = text.trim().match(/^@(\w+)/);
    const key = m ? m[1].toLowerCase() : 'juno';
    return { at: m ? m[1] : '', known: !!ROUTES[key], r: ROUTES[key] || ROUTES.juno };
  }
  function route() {
    const { at, known, r } = routeFor(field.value);
    dest.name.textContent = r[0];
    dest.where.textContent = r[1];
    dest.note.textContent = r[2];
    dest.hint.textContent = at && !known ? 'You have no agent or project called @' + at + ', so this goes to juno.' : DEFAULT_HINT;
  }

  function showReply(who, text) {
    reply.hidden = false;
    reply.textContent = '';
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    const t = document.createElement('span');
    t.textContent = text;
    reply.append(w, t);
    reply.classList.remove('pop');
    void reply.offsetWidth;
    reply.classList.add('pop');
  }

  function send(text) {
    const q = text.trim();
    if (!q) return;
    const { r } = routeFor(q);
    const body = q.replace(/^@\w+\s*/, '');
    field.value = '';
    route();
    if (/cost per lead|target/i.test(body)) {
      const rq = $('[data-r-q]', cap);
      if (rq) rq.textContent = body;
      reply.hidden = true;
      setState('recall');
      setStatus('Demo: the answer comes from a past call, with its source. Nothing left this page.');
    } else if (/^do\s/i.test(body)) {
      showReply('juno', 'On your Mac I would do this with your mouse and keyboard, and ask you before sending anything.');
      setStatus('Demo only. Nothing left this page.');
    } else {
      showReply(r[0], r[0] === 'juno'
        ? 'On your Mac I would answer this from your past sessions, or ask Claude.'
        : 'Got it. I will work on this in ' + r[1] + '.');
      setStatus('Demo: on your Mac this would go to ' + r[0] + '. Nothing left this page.');
    }
  }

  modes.forEach((b) => b.addEventListener('click', () => {
    setState(b.getAttribute('data-state'));
    setStatus('');
    if (b.getAttribute('data-state') === 'typing') field.focus();
  }));

  field.addEventListener('input', route);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send(field.value);
    } else if (e.key === 'ArrowUp' && !field.value) {
      e.preventDefault();
      setState('waiting');
      const first = $('.wait', cap);
      if (first) first.focus();
    }
  });

  // Try buttons type the example into the Capsule, then send it.
  let typing = 0;
  $$('[data-try]').forEach((b) => b.addEventListener('click', () => {
    const text = b.getAttribute('data-try');
    clearInterval(typing);
    setState('typing');
    reply.hidden = true;
    setStatus('');
    field.value = '';
    let i = 0;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { field.value = text; route(); send(text); return; }
    typing = setInterval(() => {
      i += 2;
      field.value = text.slice(0, i);
      route();
      if (i >= text.length) { clearInterval(typing); setTimeout(() => send(text), 350); }
    }, 28);
  }));

  // The mic: on a Mac, Deepgram turns speech into text. Here it only says so.
  const mic = $('.cap-mic', cap);
  if (mic) mic.addEventListener('click', () => {
    const on = mic.getAttribute('aria-pressed') !== 'true';
    mic.setAttribute('aria-pressed', String(on));
    setStatus(on ? 'Demo: on your Mac you would talk now, and Deepgram would type it. This page does not record.' : '');
  });

  // Held: Send and Edit.
  const msg = $('.st-held .msg', cap);
  $$('[data-demo-send]', cap).forEach((b) => b.addEventListener('click', () => {
    if (msg) msg.removeAttribute('contenteditable');
    setStatus('Demo: on your Mac, Send sends the exact text you see. Nothing left this page.');
  }));
  $$('[data-demo-edit]', cap).forEach((b) => b.addEventListener('click', () => {
    if (!msg) return;
    msg.setAttribute('contenteditable', 'true');
    msg.focus();
    setStatus('Change the text, then press Send.');
  }));

  // Waiting: pick a row with the arrows or a click, Enter or a second click reviews it.
  const waits = $$('.wait', cap);
  function review(row) {
    if (/juno/.test(row.textContent)) {
      setState('held');
      setStatus('');
    } else {
      setStatus('Demo: kit\'s email to 14 Northwind Bakery customers waits for your OK. This demo only opens juno\'s draft.');
    }
  }
  waits.forEach((row, i) => {
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('click', () => {
      if (row.classList.contains('on')) { review(row); return; }
      waits.forEach((w) => w.classList.toggle('on', w === row));
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); review(row); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = waits[Math.min(waits.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        waits.forEach((w) => w.classList.toggle('on', w === next));
        next.focus();
      }
    });
  });

  // The dialog: ⌥Space (or Control twice) opens the same Capsule over the page.
  const demo = $('#demo');
  const mount = $('#demo-mount');
  if (!demo || !mount || typeof demo.showModal !== 'function') return;
  const home = document.createElement('div');
  let opener = null;

  function open() {
    if (demo.open) return;
    opener = document.activeElement;
    home.style.height = wrap.offsetHeight + 'px';
    wrap.replaceWith(home);
    mount.appendChild(wrap);
    setState('typing');
    setStatus('');
    reply.hidden = true;
    demo.showModal();
    field.focus();
  }
  function close() { if (demo.open) demo.close(); }
  demo.addEventListener('close', () => {
    home.replaceWith(wrap);
    if (opener && opener.focus) opener.focus();
  });

  $$('[data-open-demo]').forEach((b) => b.addEventListener('click', open));
  $$('[data-close-demo]', demo).forEach((b) => b.addEventListener('click', close));
  demo.addEventListener('click', (e) => { if (e.target === demo) close(); });

  // Option-Space toggles the Capsule, the same default as on a Mac. Control pressed twice, with
  // no other key between, does too: the optional toggle a person can turn on from the menu bar.
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'Space') {
      e.preventDefault();
      if (demo.open) close(); else open();
    }
  });
  let last = 0;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Control') { last = 0; return; }
    if (e.repeat) return;
    const now = Date.now();
    if (now - last < 450) {
      last = 0;
      if (demo.open) close(); else open();
    } else {
      last = now;
    }
  });
})();
