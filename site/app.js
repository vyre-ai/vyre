// vyre.run: copy buttons, your own address, the Capsule states, and the Control-Control demo.
(() => {
  'use strict';

  // Copy the install command.
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const label = btn.querySelector('[data-copy-label]');
      const ariaLabel = btn.dataset.aria || (btn.dataset.aria = btn.getAttribute('aria-label') || '');
      try {
        await navigator.clipboard.writeText(btn.getAttribute('data-copy'));
        if (label) label.textContent = 'Copied';
        btn.setAttribute('aria-label', 'Copied');
      } catch (e) {
        if (label) label.textContent = 'Select it';
      }
      setTimeout(() => {
        if (label) label.textContent = 'Copy';
        if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
      }, 2000);
    });
  });

  // Your name becomes your address everywhere on the page.
  const nameIn = document.getElementById('yourname');
  const hosts = document.querySelectorAll('[data-host]');
  if (nameIn) {
    nameIn.addEventListener('input', () => {
      const clean = nameIn.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20);
      if (clean !== nameIn.value) nameIn.value = clean;
      const host = (clean || 'yourname') + '.vyre.run';
      hosts.forEach((el) => { el.textContent = host; });
      nameIn.style.width = Math.max(clean.length || 8, 3) + 0.2 + 'ch';
    });
  }

  // Capsule state tabs: each group drives the capsule whose id it names.
  function setState(group, state) {
    const cap = document.getElementById(group.getAttribute('data-cap-tabs'));
    if (!cap) return;
    cap.setAttribute('data-state', state);
    group.querySelectorAll('[data-state]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-state') === state));
    });
  }
  document.querySelectorAll('[data-cap-tabs]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('[data-state]');
      if (b) setState(group, b.getAttribute('data-state'));
    });
  });

  // Install tabs: Linux box / Mac / What it needs. One group can appear more than once on the
  // page (the hero and the end-of-page install both use it), so this wires every `.itabs` found.
  // Each tab's id ends in a stable key ("linux", "mac", "needs") shared across both groups; that
  // key is what a remembered choice and the OS guess are stored and matched by.
  const tabKey = (el) => el.id.split('-').pop();
  const STORE_KEY = 'vyre-install-os';
  const readStored = () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } };
  const writeStored = (key) => { try { localStorage.setItem(STORE_KEY, key); } catch {} };
  // A guess only, and only for the default: Mac reads as "mac" (checked in both platform and the
  // UA string, since navigator.platform can be frozen or absent and a --user-agent override does
  // not always change it), anything else stays "linux". A person can always click a different tab.
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const guessOs = /mac/i.test(platform) || /mac/i.test(navigator.userAgent || '') ? 'mac' : 'linux';

  document.querySelectorAll('.itabs').forEach((tabs) => {
    const tabEls = [...tabs.querySelectorAll('.itab')];
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
    // Default: a remembered choice wins, then the OS guess, then whatever the markup already
    // marks selected. Silent (does not re-write the choice a person didn't just make).
    const want = readStored() || guessOs;
    const initial = tabEls.find((t) => tabKey(t) === want);
    if (initial && !initial.matches('[aria-selected="true"]')) select(initial, { remember: false });
  });

  // The demo.
  const demo = document.getElementById('demo');
  if (!demo || typeof demo.showModal !== 'function') return;
  const demoTabs = demo.querySelector('[data-cap-tabs]');
  const field = document.getElementById('cap-field');
  const status = demo.querySelector('[data-demo-status]');
  const destName = demo.querySelector('[data-dest-name]');
  const destWhere = demo.querySelector('[data-dest-where]');
  const destNote = demo.querySelector('[data-dest-note]');
  const destHint = demo.querySelector('[data-dest-hint]');
  const AGENTS = {
    juno: ['your assistant', 'default', 'juno can start any session or type into it.'],
    kit: ['Harlow Legal › Q3 report', 'thread · 4 days', 'kit works on the Harlow deck in this thread.'],
    pax: ['Northwind Bakery › new thread', 'new thread', 'pax can read Northwind Bakery and nothing else.'],
  };
  let opener = null;

  function route() {
    const m = field.value.match(/^@(\w+)/);
    const who = m && AGENTS[m[1].toLowerCase()] ? m[1].toLowerCase() : 'juno';
    const [where, note, hint] = AGENTS[who];
    destName.textContent = who;
    destWhere.textContent = where;
    destNote.textContent = note;
    destHint.textContent = m && !AGENTS[m[1].toLowerCase()] ? 'You have no agent called @' + m[1] + ', so this goes to juno.' : hint;
  }

  function open() {
    if (demo.open) return;
    opener = document.activeElement;
    setState(demoTabs, 'typing');
    status.textContent = '';
    demo.showModal();
    field.focus();
  }
  function close() { if (demo.open) demo.close(); }
  demo.addEventListener('close', () => { if (opener && opener.focus) opener.focus(); });

  document.querySelectorAll('[data-open-demo]').forEach((b) => b.addEventListener('click', open));
  demo.querySelector('[data-close-demo]').addEventListener('click', close);
  demo.addEventListener('click', (e) => { if (e.target === demo) close(); });
  demoTabs.addEventListener('click', () => {
    if (demo.querySelector('#cap-demo').getAttribute('data-state') === 'typing') field.focus();
  });

  field.addEventListener('input', route);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!field.value.trim()) return;
      status.textContent = 'Demo only. On your Mac this would go to ' + destName.textContent + '. Nothing left this page.';
      field.value = '';
      route();
    } else if (e.key === 'ArrowUp' && !field.value) {
      e.preventDefault();
      setState(demoTabs, 'waiting');
    }
  });
  demo.querySelectorAll('[data-demo-send]').forEach((b) => b.addEventListener('click', () => {
    status.textContent = 'Demo only. On your Mac, Send sends the exact text you see. Nothing left this page.';
  }));

  // Option-Space toggles the Capsule, same as the real default. Control pressed twice, with no
  // other key in between, does too: that's the optional toggle a person turns on from the
  // menu-bar mark, kept here so the demo matches either way someone tries it.
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
