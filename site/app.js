// vyre.run: copy buttons, your own address, the Capsule states, and the Control-Control demo.
(() => {
  'use strict';

  // Copy the install command.
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const label = btn.querySelector('[data-copy-label]');
      try {
        await navigator.clipboard.writeText(btn.getAttribute('data-copy'));
        if (label) label.textContent = 'Copied';
        btn.setAttribute('aria-label', 'Copied the install command');
      } catch (e) {
        if (label) label.textContent = 'Select it';
      }
      setTimeout(() => {
        if (label) label.textContent = 'Copy';
        btn.setAttribute('aria-label', 'Copy the install command');
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
  document.querySelectorAll('.itabs').forEach((tabs) => {
    const tabEls = [...tabs.querySelectorAll('.itab')];
    const select = (tab) => {
      tabEls.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
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
    juno: ['your assistant', 'default', 'juno can start or drive any session.'],
    kit: ['Harlow Legal › Q3 report', 'thread · 4 days', 'kit keeps the Harlow deck in this thread.'],
    pax: ['Northwind Bakery › new thread', 'new thread', 'pax only reads Northwind Bakery.'],
  };
  let opener = null;

  function route() {
    const m = field.value.match(/^@(\w+)/);
    const who = m && AGENTS[m[1].toLowerCase()] ? m[1].toLowerCase() : 'juno';
    const [where, note, hint] = AGENTS[who];
    destName.textContent = who;
    destWhere.textContent = where;
    destNote.textContent = note;
    destHint.textContent = m && !AGENTS[m[1].toLowerCase()] ? 'No agent called @' + m[1] + '. This goes to juno.' : hint;
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
      status.textContent = 'Demo: this would go to ' + destName.textContent + '. Nothing left this page.';
      field.value = '';
      route();
    } else if (e.key === 'ArrowUp' && !field.value) {
      e.preventDefault();
      setState(demoTabs, 'waiting');
    }
  });
  demo.querySelectorAll('[data-demo-send]').forEach((b) => b.addEventListener('click', () => {
    status.textContent = 'Demo: on your Mac this sends the final words you see. Nothing left this page.';
  }));

  // Control pressed twice, with no other key in between, toggles the Capsule.
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
