/* vyre.run v2: theme, nav, copy buttons, reveal, the hero demo and the dot art. No dependencies, no trackers. */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  // Theme: follows the system until the visitor picks one.
  var qt = /[?&]theme=(light|dark)/.exec(location.search), saved = qt ? qt[1] : store('vyre-theme');
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  function isDark() { var t = root.getAttribute('data-theme'); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; }
  var tb = doc.getElementById('theme');
  if (tb) {
    tb.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      root.setAttribute('data-theme', next); store('vyre-theme', next);
      tb.setAttribute('aria-label', next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
      paintAll();
    });
    tb.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
  }
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { paintAll(); });

  // Nav
  var nav = doc.querySelector('.nav');
  function onScroll() { if (nav) nav.classList.toggle('scrolled', window.scrollY > 8); }
  onScroll(); window.addEventListener('scroll', onScroll, { passive: true });
  var mb = doc.getElementById('menu'), links = doc.getElementById('links');
  if (mb && links) {
    mb.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      mb.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.addEventListener('click', function (e) { if (e.target.tagName === 'A') { links.classList.remove('open'); mb.setAttribute('aria-expanded', 'false'); } });
  }

  // Copy buttons
  doc.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.getAttribute('data-copy'), old = b.textContent;
      function done() { b.textContent = 'Copied'; setTimeout(function () { b.textContent = old; }, 1600); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
      else { var ta = doc.createElement('textarea'); ta.value = text; doc.body.appendChild(ta); ta.select(); try { doc.execCommand('copy'); done(); } catch (e) {} ta.remove(); }
    });
  });

  // Copy a block of text by id (the agent prompt). The button reads the element at click time, so a tailored prompt copies as shown.
  doc.querySelectorAll('[data-copy-from]').forEach(function (b) {
    b.addEventListener('click', function () {
      var src = doc.getElementById(b.getAttribute('data-copy-from')); if (!src) return;
      var text = src.textContent, old = b.textContent;
      function done() { b.textContent = 'Copied'; setTimeout(function () { b.textContent = old; }, 1600); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
      else { var ta = doc.createElement('textarea'); ta.value = text; doc.body.appendChild(ta); ta.select(); try { doc.execCommand('copy'); done(); } catch (e) {} ta.remove(); }
    });
  });

  // Map your business (/map/): the form builds a tailored prompt and a live sketch of the firm on Vyre. No network, nothing stored.
  var mapEl = doc.getElementById('mapper'), mapJson = doc.getElementById('map-data'), outEl = doc.getElementById('prompt-out');
  if (mapEl && mapJson && outEl) (function () {
    var D = JSON.parse(mapJson.textContent), CATS = ['roles', 'things', 'work', 'tools', 'nevers'];
    var base = outEl.textContent, opts = {}, sel = {}, custom = {};
    var ind = doc.getElementById('m-industry'), size = doc.getElementById('m-size'), sketch = doc.getElementById('sketch');
    function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function has(a, x) { return a.indexOf(x) > -1; }
    function setIndustry() {
      var p = D.industries[ind.value];
      CATS.forEach(function (c) {
        var cu = custom[c] || (custom[c] = []);
        opts[c] = p[c].concat(D.more[c].filter(function (x) { return !has(p[c], x); }), cu.filter(function (x) { return !has(p[c], x) && !has(D.more[c], x); }));
        sel[c] = p[c].concat(cu);
      });
      chips();
    }
    function chips() {
      CATS.forEach(function (c) {
        var box = mapEl.querySelector('[data-cat="' + c + '"]'); box.textContent = '';
        opts[c].forEach(function (name) {
          var b = el('button', '', name); b.type = 'button'; b.setAttribute('aria-pressed', has(sel[c], name) ? 'true' : 'false');
          b.addEventListener('click', function () {
            if (has(sel[c], name)) sel[c].splice(sel[c].indexOf(name), 1); else sel[c].push(name);
            b.setAttribute('aria-pressed', has(sel[c], name) ? 'true' : 'false'); update();
          });
          box.appendChild(b);
        });
      });
      update();
    }
    function add(c) {
      var inp = mapEl.querySelector('[data-add="' + c + '"]'), v = inp.value.replace(/\s+/g, ' ').trim();
      if (!v) return; inp.value = '';
      if (!has(opts[c], v)) { opts[c].push(v); custom[c].push(v); }
      if (!has(sel[c], v)) sel[c].push(v);
      chips();
    }
    CATS.forEach(function (c) {
      var inp = mapEl.querySelector('[data-add="' + c + '"]'), btn = mapEl.querySelector('[data-addbtn="' + c + '"]');
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(c); } });
      btn.addEventListener('click', function () { add(c); });
    });
    ind.addEventListener('change', setIndustry); size.addEventListener('change', update);

    function join(a) { return a.join(', '); }
    function model() {
      var roles = sel.roles.slice(), things = sel.things.slice(), approver = roles[0] || 'the owner', doer = roles[roles.length - 1] || 'the owner';
      var rec = things.map(function (t, i) {
        var d = D.things[t] || ['Name, Status, Owner, Dates', ''];
        return { name: t, fields: d[0], sealed: d[1], link: i === 0 ? 'Projects and tasks' : (things[0] + ', Projects') };
      });
      var wk = sel.work.map(function (w) { var d = D.work[w] || { stages: ['To do', 'In progress', 'Review', 'Done'], trigger: 'A person, a schedule or a record change', steps: ['Find the record', 'Agent drafts', 'Ask a person', 'Carry out'], gate: 'Anything that leaves the team', agent: [w + ' helper', 'does the first pass; a person decides'] }; return { name: w, d: d }; });
      var tl = sel.tools.map(function (t) { return { name: t, planned: has(D.planned, t) }; });
      return { roles: roles, rec: rec, wk: wk, tl: tl, nevers: sel.nevers.slice(), approver: approver, doer: doer };
    }
    function table(head, rows) {
      var w = el('div', 'tblw'), t = el('table'), th = el('thead'), tr = el('tr');
      head.forEach(function (h) { tr.appendChild(el('th', '', h)); }); th.appendChild(tr); t.appendChild(th);
      var tb = el('tbody'); rows.forEach(function (r) { var x = el('tr'); r.forEach(function (c) { var td = el('td'); if (c && c.nodeType) td.appendChild(c); else td.textContent = c; x.appendChild(td); }); tb.appendChild(x); });
      t.appendChild(tb); w.appendChild(t); return w;
    }
    function render(m) {
      sketch.textContent = '';
      var sz = size.value;
      sketch.appendChild(el('h3', '', 'People become members'));
      sketch.appendChild(el('p', 'sk-sum', 'A Space for ' + sz + ' people, plus the agents that work beside them. One server, one Space, roles decide who sees what.'));
      sketch.appendChild(table(['Role', 'In Vyre', 'Reach'], [['Owner (you)', 'Owner', 'Everything, and the Gate'] ].concat(m.roles.map(function (r) { return [r, 'Member with a role', 'The records and projects their role and project team allow']; }))));
      sketch.appendChild(el('h3', '', 'Things become record types'));
      sketch.appendChild(table(['Record type', 'Fields', 'Links to'], m.rec.map(function (r) {
        var f = el('span'); f.appendChild(doc.createTextNode(r.fields)); if (r.sealed) { f.appendChild(el('br')); f.appendChild(el('span', 'seal', 'Sealed: ' + r.sealed)); } return [r.name, f, r.link];
      })));
      sketch.appendChild(el('h3', '', 'Work becomes Playbooks and Flows'));
      m.wk.forEach(function (w) {
        var b = el('div', 'skblock'), p = el('p'); p.appendChild(el('b', '', w.name)); p.appendChild(doc.createTextNode(' Playbook: ' + join(w.d.stages)));
        b.appendChild(p); var fl = el('ul', 'flow'); fl.appendChild(el('li', 'tr', w.d.trigger));
        w.d.steps.forEach(function (s) { fl.appendChild(el('li', '', s)); });
        fl.appendChild(el('li', 'ap', 'Needs you: ' + w.d.gate + ' (' + m.approver + ')')); b.appendChild(fl); sketch.appendChild(b);
      });
      if (!m.wk.length) sketch.appendChild(el('p', 'sk-sum', 'Pick the work you repeat and each kind becomes its own Playbook and Flows, side by side over the same records.'));
      sketch.appendChild(el('h3', '', 'Agents with one job each'));
      sketch.appendChild(table(['Agent', 'Job and reach'], m.wk.map(function (w) { return [w.d.agent[0], w.d.agent[1] + '. Shared with ' + m.doer + '.']; })));
      if (m.nevers.length) {
        sketch.appendChild(el('h3', '', 'Held at the Gate until a person says yes'));
        var ul = el('ul', 'flow'); m.nevers.forEach(function (n) { ul.appendChild(el('li', 'ap', n)); }); sketch.appendChild(ul);
      }
      if (m.tl.length) {
        sketch.appendChild(el('h3', '', 'Your tools'));
        sketch.appendChild(table(['Tool', 'How it connects'], m.tl.map(function (t) {
          var c = el('span'); c.appendChild(doc.createTextNode('Today: a connection plus a Flow step, or a custom module. ')); c.appendChild(el('span', 'next', t.planned ? 'Next 0.5.2: packaged Integration' : 'Next 0.5.2: make an Integration from its API')); c.appendChild(doc.createTextNode('*'));
          return [t.name, c];
        })));
        sketch.appendChild(el('p', 'sk-sum', '*Where the vendor provides an API.'));
      }
    }
    function prompt(m) {
      var L = ['', '', 'ABOUT MY BUSINESS (already answered; start from this and ask only what is missing)',
        'Industry: ' + D.industries[ind.value].name, 'Team size: ' + size.value + ' people',
        'Roles: ' + (join(m.roles) || 'not said yet'), 'What we track: ' + (join(sel.things) || 'not said yet'),
        'Work we repeat: ' + (join(sel.work) || 'not said yet'), 'Tools we use: ' + (join(sel.tools) || 'not said yet'),
        'Must never go out without a yes: ' + (join(m.nevers) || 'not said yet'), '',
        'MY FIRST SKETCH (correct anything that is wrong for my firm)',
        'Members: the owner, plus ' + (join(m.roles) || 'my team') + ', each a member with a role.',
        'Record types: ' + (m.rec.map(function (r) { return r.name + ' (' + r.fields + (r.sealed ? '; sealed: ' + r.sealed : '') + ')'; }).join('; ') || 'to decide') + '.',
        'Playbooks and Flows: ' + (m.wk.map(function (w) { return w.name + ' (' + w.d.trigger.toLowerCase() + ', approval: ' + w.d.gate.toLowerCase() + ')'; }).join('; ') || 'to decide') + '.',
        'Tools to connect: ' + (join(sel.tools) || 'to decide') + '.'];
      return base + L.join('\n');
    }
    function update() { var m = model(); render(m); outEl.textContent = prompt(m); var l = doc.getElementById('out-lbl'); if (l) l.textContent = 'Prompt · tailored to your firm'; }
    setIndustry();
  })();

  // Reveal on scroll
  var rv = doc.querySelectorAll('.rv');
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { rootMargin: '0px 0px -8% 0px' });
    rv.forEach(function (el) { io.observe(el); });
  } else rv.forEach(function (el) { el.classList.add('in'); });

  // Hero demo: three scenes, typed, then answered. Sample data only.
  var demo = doc.getElementById('demo');
  if (demo) {
    var ask = demo.querySelector('.q'), scenes = demo.querySelectorAll('.scene'), dots = demo.querySelectorAll('.dots i');
    var qs = ['what did Northwind ask for on the order form?', '@codex rename the intake form fields', 'email Northwind the new order form'];
    var i = 0, timer = null, running = false;
    function show(n) { demo.classList.remove('typing'); scenes.forEach(function (s, k) { s.classList.toggle('on', k === n); }); dots.forEach(function (d, k) { d.classList.toggle('on', k === n); }); }
    function type(n, done) {
      var s = qs[n], c = 0; ask.textContent = '';
      demo.classList.add('typing');
      (function step() { ask.textContent = s.slice(0, ++c); if (c < s.length) timer = setTimeout(step, 28 + Math.random() * 30); else timer = setTimeout(done, 380); })();
    }
    function cycle() { type(i, function () { show(i); timer = setTimeout(function () { i = (i + 1) % qs.length; cycle(); }, 4600); }); }
    function start() { if (running || reduce) return; running = true; cycle(); }
    function stop() { running = false; clearTimeout(timer); }
    ask.textContent = qs[0]; show(0);
    if ('IntersectionObserver' in window && !reduce) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { e.isIntersecting ? start() : stop(); }); }).observe(demo);
    }
  }

  // Dot art. Colours come from the theme, so repaint on change.
  var painters = [];
  function cssv(n) { return getComputedStyle(root).getPropertyValue(n).trim(); }
  function fit(c) { var r = c.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2); c.width = Math.max(1, Math.round(r.width * d)); c.height = Math.max(1, Math.round(r.height * d)); return { w: r.width, h: r.height, d: d, x: c.getContext('2d') }; }

  // Hero: a field of dots whose size rides two slow waves, strongest at the edges.
  function field(c) {
    var t0 = 0, raf = 0, vis = true;
    function draw(t) {
      var g = fit(c), x = g.x; x.scale(g.d, g.d); x.clearRect(0, 0, g.w, g.h);
      x.fillStyle = cssv('--dot'); var gap = g.w < 700 ? 11 : 14, tt = (t || 0) / 1000;
      for (var yy = gap / 2, row = 0; yy < g.h; yy += gap, row++) {
        for (var xx = gap / 2; xx < g.w; xx += gap) {
          var nx = xx / g.w, edge = Math.min(1, .12 + Math.pow(Math.abs(nx - .5) * 2, 1.1));
          var wv = (Math.sin(xx * .012 + tt * .8 + row * .08) + Math.sin(yy * .021 - tt * .6) + 2) / 4;
          var vy = yy / g.h, fade = Math.min(1, Math.sin(Math.min(1, vy * 1.15) * 3.1416) * 1.3 + .1);
          var r = gap * .5 * edge * wv * fade * 1.15;
          if (r > .35) { x.beginPath(); x.arc(xx, yy, r, 0, 6.2832); x.fill(); }
        }
      }
    }
    function loop(t) { if (vis) draw(t); raf = requestAnimationFrame(loop); }
    painters.push(function () { draw(performance.now()); });
    draw(0);
    if (!reduce) {
      if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { vis = es[0].isIntersecting; }).observe(c);
      var last = 0; (function tick(t) { if (vis && t - last > 90) { draw(t); last = t; } requestAnimationFrame(tick); })(0);
    }
  }

  // The Vyre mark in halftone dots, drawn from its own stroke.
  function mark(c) {
    var accentOn = c.getAttribute('data-accent') !== 'off';
    function draw(ph) {
      var g = fit(c), x = g.x, S = 96, off = doc.createElement('canvas'); off.width = off.height = S;
      var o = off.getContext('2d'), k = S / 24 * .78, ox = (S - 24 * k) / 2 + 1.2 * k, oy = (S - 24 * k) / 2 + .6 * k;
      o.translate(ox, oy); o.scale(k, k); o.strokeStyle = '#fff'; o.fillStyle = '#fff'; o.lineWidth = 2.6; o.lineCap = 'round'; o.lineJoin = 'round';
      o.beginPath(); o.moveTo(3.5, 5.5); o.lineTo(12, 19.5); o.lineTo(17.96, 9.69); o.stroke();
      o.beginPath(); o.arc(20.5, 5.5, 2.3, 0, 7); o.fill();
      var data = o.getImageData(0, 0, S, S).data;
      x.scale(g.d, g.d); x.clearRect(0, 0, g.w, g.h);
      var n = g.w < 300 ? 44 : 64, cell = g.w / n;
      for (var j = 0; j < n; j++) for (var i = 0; i < n; i++) {
        var sx = Math.floor((i + .5) / n * S), sy = Math.floor((j + .5) / n * S), v = data[(sy * S + sx) * 4 + 3] / 255;
        // soften the stroke edge so the dots fall off like a screen print
        var sum = 0, cnt = 0; for (var a = -3; a <= 3; a += 3) for (var b = -3; b <= 3; b += 3) { var px = Math.min(S - 1, Math.max(0, sx + a)), py = Math.min(S - 1, Math.max(0, sy + b)); sum += data[(py * S + px) * 4 + 3] / 255; cnt++; }
        var s = (v * .6 + sum / cnt * .4);
        var scan = .5 + .5 * Math.sin(ph * 2 - j * .35);
        var r = cell * .5 * Math.pow(s, .8) * (.78 + .22 * scan);
        if (r > .3) { x.fillStyle = (accentOn && i > n * .74 && j < n * .34) ? '#B8A4FF' : '#F1EEE6'; x.beginPath(); x.arc((i + .5) * cell, (j + .5) * cell, r, 0, 6.2832); x.fill(); }
        else if ((i + j) % 2 === 0 && Math.sin(i * 12.9898 + j * 78.233) > .93) { x.fillStyle = 'rgba(241,238,230,.18)'; x.fillRect((i + .5) * cell - .6, (j + .5) * cell - .6, 1.2, 1.2); }
      }
    }
    painters.push(function () { draw(0); });
    draw(0);
    if (!reduce && 'IntersectionObserver' in window) {
      var vis = false, last = 0; new IntersectionObserver(function (es) { vis = es[0].isIntersecting; }).observe(c);
      (function tick(t) { if (vis && t - last > 110) { draw(t / 1000); last = t; } requestAnimationFrame(tick); })(0);
    }
  }
  function paintAll() { painters.forEach(function (p) { p(); }); }
  doc.querySelectorAll('canvas.field').forEach(field);
  doc.querySelectorAll('canvas.markart').forEach(mark);
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(paintAll, 150); });
})();
