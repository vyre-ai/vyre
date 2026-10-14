// Map your business (/map/): a five-step guide, a live SVG diagram of the business on Vyre, a result section and the actions.
// No network calls. Nothing is stored except the URL hash (the share link). Data comes from the #map-data JSON that
// scripts/site/agent-prompt.mjs writes into the page.
(function () {
  var doc = document;
  var root = doc.getElementById('mapper'), dataEl = doc.getElementById('map-data'), out = doc.getElementById('prompt-out');
  if (!root || !dataEl || !out) return;
  var D = JSON.parse(dataEl.textContent);
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var CATS = ['roles', 'things', 'work', 'tools', 'nevers'];
  var KEY = { roles: 'r', things: 't', work: 'w', tools: 'l', nevers: 'n' };
  var NS = 'http://www.w3.org/2000/svg';
  var basePrompt = out.textContent;
  var STEP_FOCUS = [null, ['people', 'agents'], ['records'], ['work', 'agents'], ['tools', 'work']];
  var STEP_NAMES = ['Business', 'Team', 'Track', 'Repeat', 'Tools'];

  var S = { ind: '', size: 1, step: 0, sel: {}, extra: {}, touched: false };
  CATS.forEach(function (c) { S.sel[c] = []; S.extra[c] = []; });

  function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function sv(tag, attrs) { var e = doc.createElementNS(NS, tag); if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function has(a, x) { return a.indexOf(x) > -1; }
  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function clean(s) { return String(s).replace(/[~&=#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function ind() { return S.ind ? own(D.industries, S.ind) : null; }
  function preset(c) { var p = ind(); return p ? p[c] : []; }
  function opts(c) { return uniq(preset(c).concat(D.more[c], S.extra[c])); }

  // ---------- state: choices, presets, the URL hash ----------
  function setIndustry(k) {
    S.ind = k;
    CATS.forEach(function (c) { S.sel[c] = uniq(preset(c).concat(S.extra[c])); });
  }
  function writeHash() {
    if (!S.touched || !window.history || !history.replaceState) return;
    var q = new URLSearchParams();
    if (S.ind) q.set('i', S.ind);
    q.set('z', String(S.size)); q.set('p', String(S.step + 1));
    CATS.forEach(function (c) { q.set(KEY[c], S.sel[c].join('~')); });
    try { history.replaceState(null, '', '#' + q.toString()); } catch (e) {}
  }
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (h.indexOf('i=') < 0 && h.indexOf('z=') < 0) return false;
    var q = new URLSearchParams(h), i = q.get('i');
    if (i && own(D.industries, i)) S.ind = i; else return false;
    var z = parseInt(q.get('z'), 10); if (z >= 0 && z < D.sizes.length) S.size = z;
    var p = parseInt(q.get('p'), 10); if (p >= 1 && p <= 5) S.step = p - 1;
    CATS.forEach(function (c) {
      var v = q.get(KEY[c]);
      if (v == null) { S.sel[c] = preset(c).slice(); return; }
      var list = v.split('~').map(clean).filter(Boolean).slice(0, 24);
      S.sel[c] = uniq(list);
      S.extra[c] = list.filter(function (x) { return !has(preset(c), x) && !has(D.more[c], x); });
    });
    S.touched = true;
    return true;
  }

  // ---------- the model of the business ----------
  function model() {
    var roles = S.sel.roles.slice(), approver = roles[0] || 'the owner';
    var rec = S.sel.things.map(function (t) { var d = own(D.things, t) || ['Name, Status, Owner, Dates', '']; return { name: t, fields: d[0], sealed: d[1] }; });
    var wk = S.sel.work.map(function (w) {
      var d = own(D.work, w) || { stages: ['To do', 'In progress', 'Review', 'Done'], trigger: 'A person, a schedule or a record change', steps: ['Find the record', 'Agent drafts', 'Ask a person', 'Carry out'], gate: 'Anything that leaves the team', agent: [w + ' helper', 'does the first pass; a person decides'], custom: true };
      return { name: w, d: d };
    });
    var tl = S.sel.tools.map(function (t) { return { name: t, planned: has(D.planned, t) }; });
    return { roles: roles, rec: rec, wk: wk, tl: tl, nevers: S.sel.nevers.slice(), approver: approver };
  }

  // ---------- the diagram ----------
  var wrap = doc.getElementById('dg-wrap');
  var svg = sv('svg', { 'class': 'dg', role: 'img', 'aria-label': 'Your business on Vyre: people, agents, records, Playbooks and Flows, and the tools you connect.' });
  var defs = sv('defs'), mk = sv('marker', { id: 'dg-arr', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto' });
  mk.appendChild(sv('path', { d: 'M0 0L8 4L0 8z', 'class': 'arr' })); defs.appendChild(mk); svg.appendChild(defs);
  var gE = sv('g', { 'class': 'edges' }), gN = sv('g', { 'class': 'nodes' }); svg.appendChild(gE); svg.appendChild(gN);
  if (wrap) wrap.appendChild(svg);
  var nodeMap = {}, edgeMap = {}, curW = 0;

  function fit(s, px, cw) { var n = Math.max(3, Math.floor(px / (cw || 5.4))); return s.length > n ? s.slice(0, n - 1).replace(/\s+$/, '') + '…' : s; }
  function wrap2(s, n) {
    if (s.length <= n) return [s];
    var words = s.split(' '), a = '', i = 0;
    while (i < words.length && (a + ' ' + words[i]).trim().length <= n) { a = (a + ' ' + words[i]).trim(); i++; }
    if (!a) { a = s.slice(0, n); i = 0; var rest = s.slice(n); return [a, fit(rest, n * 5.4, 5.4)]; }
    return [a, fit(words.slice(i).join(' '), n * 5.4, 5.4)];
  }
  function cap(list, n) { if (list.length <= n) return list; var r = list.slice(0, n - 1); r.push({ id: 'more', label: '+' + (list.length - n + 1) + ' more', more: true }); return r; }

  function layout(m, W) {
    var narrow = W < 560, N = [], E = [];
    function node(o) { N.push(o); return o; }
    function edge(id, a, b, cls, mode) { E.push({ id: id, a: a, b: b, cls: cls, mode: mode }); }
    var persons = cap([{ id: 'p:owner', label: 'You, Owner', owner: true }].concat(m.roles.map(function (r) { return { id: 'p:' + r, label: r }; })), narrow ? 6 : 7);
    var agents = cap(m.wk.map(function (w) { return { id: 'a:' + w.name, label: w.d.agent[0], tip: w.d.agent[0] + ': ' + w.d.agent[1] }; }), narrow ? 6 : 6);
    var recs = cap(m.rec.map(function (r) { return { id: 'r:' + r.name, label: r.name, tip: r.name + ': ' + r.fields }; }), 8);
    var tools = cap(m.tl.map(function (t) { return { id: 't:' + t.name, label: t.name, tip: t.name + ' (connection)' }; }), 7);
    var y0 = 24, pitch = 36, bandH, ring = { cx: 0, cy: 0, rx: 0, ry: 0 }, endY;

    function head(id, x, y, text, band) { node({ id: id, kind: 'label', band: band, x: x, y: y, text: text.toUpperCase(), w: 0, h: 0 }); }
    function ghost(id, x, y, lines, band, w) { node({ id: id, kind: 'ghost', band: band, x: x, y: y, lines: lines, w: w || 0, h: 0 }); }
    function pillNode(o, kind, x, y, w, h, band) { o.kind = kind; o.band = band; o.x = x; o.y = y; o.w = w; o.h = h; return node(o); }

    if (!narrow) {
      var cols = { p: [0, 132], a: [152, 124], t: [596, 124] };
      bandH = Math.max(232, Math.max(persons.length, agents.length, tools.length) * pitch + 4);
      head('h:people', 0, 8, 'People', 'people'); head('h:agents', cols.a[0], 8, 'Agents', 'agents');
      head('h:records', 300, 8, 'Records', 'records'); head('h:tools', cols.t[0], 8, 'Tools', 'tools');
      persons.forEach(function (p, i) { pillNode(p, p.more ? 'more' : 'person', 0, y0 + i * pitch, cols.p[1], 30, 'people'); });
      agents.forEach(function (a, i) { pillNode(a, a.more ? 'more' : 'agent', cols.a[0], y0 + i * pitch, cols.a[1], 30, 'agents'); });
      if (!agents.length) ghost('g:agents', cols.a[0], y0 + 14, ['Agents appear', 'with your work'], 'agents', cols.a[1]);
      tools.forEach(function (t, i) { pillNode(t, t.more ? 'more' : 'tool', cols.t[0], y0 + i * pitch, cols.t[1], 28, 'tools'); });
      if (!tools.length) ghost('g:tools', cols.t[0], y0 + 14, ['Your tools', 'connect here'], 'tools', cols.t[1]);
      ring = { cx: 430, cy: y0 + bandH / 2 - 8, rx: 100, ry: Math.max(70, bandH / 2 - 34) };
      agents.forEach(function (a, i) {
        if (a.more) return;
        var pi = Math.min(i + 1, persons.length - 1);
        edge('e:pa:' + i, { x: cols.p[1], y: y0 + pi * pitch + 15 }, { x: cols.a[0], y: y0 + i * pitch + 15 }, 'pa', 'curve');
      });
    } else {
      var pw = 104, ph = 28, gx = 8, per = 3;
      var yy = 8;
      head('h:people', 0, yy, 'People', 'people'); yy += 12;
      persons.forEach(function (p, i) { pillNode(p, p.more ? 'more' : 'person', (i % per) * (pw + gx) + 2, yy + Math.floor(i / per) * (ph + 8), pw, ph, 'people'); });
      yy += Math.ceil(persons.length / per) * (ph + 8) + 10;
      head('h:agents', 0, yy, 'Agents', 'agents'); yy += 12;
      if (agents.length) {
        agents.forEach(function (a, i) { pillNode(a, a.more ? 'more' : 'agent', (i % per) * (pw + gx) + 2, yy + Math.floor(i / per) * (ph + 8), pw, ph, 'agents'); });
        yy += Math.ceil(agents.length / per) * (ph + 8) + 10;
      } else { ghost('g:agents', 2, yy + 10, ['Agents appear with your work'], 'agents'); yy += 40; }
      head('h:records', 0, yy, 'Records', 'records'); yy += 12;
      bandH = 214; ring = { cx: W / 2, cy: yy + bandH / 2, rx: 104, ry: 82 };
      yy += bandH + 8;
      head('h:tools', 0, yy, 'Tools', 'tools'); yy += 12;
      if (tools.length) {
        tools.forEach(function (t, i) { pillNode(t, t.more ? 'more' : 'tool', (i % per) * (pw + gx) + 2, yy + Math.floor(i / per) * 36, pw, 28, 'tools'); });
        yy += Math.ceil(tools.length / per) * 36 + 6;
      } else { ghost('g:tools', 2, yy + 10, ['Your tools connect here'], 'tools'); yy += 40; }
      y0 = yy; bandH = 0;
    }

    // records as a small linked graph: the first one is the hub
    var rw = narrow ? 104 : 100, rh = 28;
    if (!recs.length) ghost('g:records', ring.cx, ring.cy - 6, ['What you track', 'appears here'], 'records', 0);
    var hub = null, outer = [];
    recs.forEach(function (r, i) {
      if (i === 0) { hub = pillNode(r, 'rec hub', ring.cx - (rw + 10) / 2, ring.cy - rh / 2, rw + 10, rh + 2, 'records'); return; }
      outer.push(r);
    });
    outer.forEach(function (r, i) {
      var a = -Math.PI / 2 + (i * 2 * Math.PI) / outer.length + (outer.length === 1 ? Math.PI / 2 : 0);
      pillNode(r, r.more ? 'more' : 'rec', ring.cx + ring.rx * Math.cos(a) - rw / 2, ring.cy + ring.ry * Math.sin(a) - rh / 2, rw, rh, 'records');
    });
    function mid(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }
    if (hub) outer.forEach(function (r, i) { edge('e:rh:' + i, mid(hub), mid(r), 'rec', 'line'); });
    if (outer.length > 2) outer.forEach(function (r, i) { var n2 = outer[(i + 1) % outer.length]; edge('e:rr:' + i, mid(r), mid(n2), 'rec soft', 'line'); });
    // tools connect at the edge, to the hub record
    if (hub) tools.forEach(function (t, i) {
      if (t.more) return;
      if (narrow) edge('e:tc:' + i, { x: t.x + t.w / 2, y: t.y }, { x: ring.cx, y: hub.y + hub.h }, 'tool', 'curveV');
      else edge('e:tc:' + i, { x: t.x, y: t.y + t.h / 2 }, { x: hub.x + hub.w, y: hub.y + hub.h / 2 }, 'tool', 'curve');
    });

    // playbooks and flows
    var ry = narrow ? y0 + 14 : y0 + bandH + 30;
    head('h:work', 0, ry - 4, 'Playbooks and Flows', 'work');
    ry += 14;
    if (!m.wk.length) { ghost('g:work', 0, ry + 14, ['The work you repeat becomes a Playbook and a Flow, one each, over the same records.'], 'work', W); ry += 50; }
    m.wk.forEach(function (w, wi) {
      var d = w.d, id = 'w' + wi + ':' + w.name;
      var agentStep = d.steps.filter(function (s) { return /agent/i.test(s); })[0] || d.steps[1] || d.steps[0];
      var first = d.steps[0] === agentStep ? (d.steps[1] || d.steps[0]) : d.steps[0];
      var items = narrow ? [{ t: d.trigger, k: 'trig' }, { t: agentStep, k: 'step' }, { t: 'Needs you: ' + d.gate, k: 'gate', n2: ['Needs you', d.gate] }]
        : [{ t: d.trigger, k: 'trig' }, { t: first, k: 'step' }, { t: agentStep, k: 'step' }, { t: 'Needs you: ' + d.gate, k: 'gate' }];
      var nameW = narrow ? W : 290;
      node({ id: 'n:' + id, kind: 'wname', band: 'work', x: 0, y: ry, w: nameW, h: 14, text: fit(w.name, narrow ? W - 8 : 180, 6.2), sub: 'Playbook, ' + d.stages.length + ' stages', tip: 'Playbook stages: ' + d.stages.join(', ') });
      var rx0 = narrow ? 4 : 350, rx1 = W - 6, railY = narrow ? ry + 26 : ry + 7;
      d.stages.forEach(function (s, k) {
        var x = d.stages.length === 1 ? rx0 : rx0 + (k * (rx1 - rx0)) / (d.stages.length - 1);
        node({ id: 'd:' + id + ':' + k, kind: 'dot', band: 'work', x: x - 4, y: railY - 4, w: 8, h: 8, tip: s });
      });
      if (d.stages.length > 1) edge('e:rail:' + id, { x: rx0, y: railY }, { x: rx1, y: railY }, 'rail', 'line');
      var cy = narrow ? ry + 40 : ry + 28, gap = narrow ? 14 : 20, cw = (W - gap * (items.length - 1)) / items.length, chars = Math.floor((cw - 16) / 5.5);
      var prev = null;
      items.forEach(function (it, k) {
        var nn = node({ id: 'c:' + id + ':' + k, kind: 'step ' + it.k, band: 'work', x: k * (cw + gap), y: cy, w: cw, h: 36, lines: it.n2 ? [it.n2[0], fit(it.n2[1], (cw - 30), 5.4)] : wrap2(it.t, chars), tip: it.t });
        if (prev) edge('e:ch:' + id + ':' + k, { x: prev.x + prev.w, y: cy + 18 }, { x: nn.x, y: cy + 18 }, 'chain', 'arrow');
        prev = nn;
      });
      ry = cy + 36 + 22;
    });
    return { nodes: N, edges: E, W: W, H: Math.max(ry, 120) };
  }

  var enterTimers = {};
  function drawNode(g, n) {
    var inn = g.firstChild; inn.textContent = '';
    var k = n.kind.split(' ')[0], w = n.w, h = n.h, t;
    function text(x, y, s, cls, anchor) { var te = sv('text', { x: x, y: y, 'class': cls || 'tx' }); if (anchor) te.setAttribute('text-anchor', anchor); te.textContent = s; inn.appendChild(te); return te; }
    if (n.tip) { var ti = sv('title'); ti.textContent = n.tip; inn.appendChild(ti); }
    if (k === 'label') { text(0, 0, n.text, 'lb'); return; }
    if (k === 'ghost') {
      n.lines.forEach(function (ln, i) { text(w ? w / 2 : 0, i * 13, ln, 'gh', w ? 'middle' : (n.w === 0 && n.id !== 'g:records' ? 'start' : 'middle')); });
      return;
    }
    if (k === 'wname') {
      t = text(0, 11, n.text, 'tx wn'); var sub = sv('tspan', { dx: 8, 'class': 'wsub' }); sub.textContent = n.sub; t.appendChild(sub); return;
    }
    if (k === 'dot') { inn.appendChild(sv('circle', { cx: 4, cy: 4, r: 3.6, 'class': 'dot' })); return; }
    var cls = 'nb ' + n.kind.replace(/ /g, ' nb-');
    inn.appendChild(sv('rect', { width: w, height: h, rx: k === 'person' ? h / 2 : (k === 'rec' ? 7 : 4), 'class': cls }));
    if (k === 'step') {
      var gate = n.kind.indexOf('gate') > -1, x0 = gate ? 22 : 8;
      if (gate) {
        inn.appendChild(sv('rect', { x: 8, y: h / 2 - 1, width: 8, height: 7, rx: 1, 'class': 'lock' }));
        inn.appendChild(sv('path', { d: 'M9.8 ' + (h / 2 - 1) + 'V' + (h / 2 - 4) + 'a2.2 2.2 0 0 1 4.4 0V' + (h / 2 - 1), 'class': 'lock-s' }));
      }
      var lines = n.lines, y = lines.length === 1 ? h / 2 + 4 : h / 2 - 2;
      lines.forEach(function (ln, i) { text(x0, y + i * 12, ln, gate ? 'tx gt' : 'tx2'); });
      return;
    }
    var pad = 12;
    if (k === 'person' && n.owner) { inn.appendChild(sv('circle', { cx: 13, cy: h / 2, r: 3.4, 'class': 'ownd' })); pad = 23; }
    if (k === 'agent') { inn.appendChild(sv('path', { d: 'M11 ' + (h / 2 - 5) + 'l5 5l-5 5l-5 -5z', 'class': 'agd' })); pad = 23; }
    if (k === 'tool') { inn.appendChild(sv('circle', { cx: 11, cy: h / 2, r: 3, 'class': 'tld' })); pad = 21; }
    if (k === 'rec') pad = 10;
    text(pad, h / 2 + 3.8, fit(n.label, w - pad - 8, 5.4), (n.kind.indexOf('hub') > -1 ? 'tx hb' : 'tx'));
  }

  function pathFor(e) {
    var a = e.a, b = e.b;
    if (e.mode === 'curve' || e.mode === 'arrow') { var mx = (a.x + b.x) / 2; return e.mode === 'arrow' ? 'M' + a.x + ' ' + a.y + 'L' + (b.x - 1) + ' ' + b.y : 'M' + a.x + ' ' + a.y + 'C' + mx + ' ' + a.y + ',' + mx + ' ' + b.y + ',' + b.x + ' ' + b.y; }
    if (e.mode === 'curveV') { var my = (a.y + b.y) / 2; return 'M' + a.x + ' ' + a.y + 'C' + a.x + ' ' + my + ',' + b.x + ' ' + my + ',' + b.x + ' ' + b.y; }
    return 'M' + a.x + ' ' + a.y + 'L' + b.x + ' ' + b.y;
  }

  function apply(L, focus) {
    svg.setAttribute('viewBox', '0 0 ' + L.W + ' ' + L.H);
    var seen = {}, eseen = {};
    L.nodes.forEach(function (n) {
      seen[n.id] = 1;
      var rec = nodeMap[n.id], tr = 'translate(' + Math.round(n.x * 10) / 10 + 'px,' + Math.round(n.y * 10) / 10 + 'px)';
      if (rec && enterTimers[n.id]) { clearTimeout(enterTimers[n.id]); delete enterTimers[n.id]; }
      if (!rec) {
        var g = sv('g', { 'class': 'nd b-' + n.band + ' k-' + n.kind.split(' ')[0] + ' enter' }); g.style.transform = tr;
        g.appendChild(sv('g', { 'class': 'inn' })); gN.appendChild(g);
        rec = nodeMap[n.id] = { g: g, sig: '' };
        drawNode(g, n); rec.sig = JSON.stringify([n.kind, n.w, n.h, n.label, n.text, n.lines, n.sub]);
        if (reduce) g.classList.remove('enter'); else { void g.getBoundingClientRect(); requestAnimationFrame(function () { g.classList.remove('enter'); }); }
      } else {
        rec.g.classList.remove('enter'); rec.g.style.transform = tr;
        var sig = JSON.stringify([n.kind, n.w, n.h, n.label, n.text, n.lines, n.sub]);
        if (sig !== rec.sig) { rec.sig = sig; drawNode(rec.g, n); }
      }
      rec.g.classList.toggle('dim', !!(focus && !has(focus, n.band)));
    });
    Object.keys(nodeMap).forEach(function (id) {
      if (seen[id] || enterTimers[id]) return;
      var rec = nodeMap[id];
      if (reduce) { rec.g.remove(); delete nodeMap[id]; return; }
      rec.g.classList.add('enter');
      enterTimers[id] = setTimeout(function () { rec.g.remove(); delete nodeMap[id]; delete enterTimers[id]; }, 420);
    });
    L.edges.forEach(function (e) {
      eseen[e.id] = 1;
      var rec = edgeMap[e.id], d = pathFor(e);
      if (rec && enterTimers[e.id]) { clearTimeout(enterTimers[e.id]); delete enterTimers[e.id]; }
      if (!rec) {
        var p = sv('path', { 'class': 'ed ed-' + e.cls.replace(/ /g, ' ed-') + ' enter', d: d });
        if (e.mode === 'arrow') p.setAttribute('marker-end', 'url(#dg-arr)');
        gE.appendChild(p); rec = edgeMap[e.id] = { p: p };
        if (reduce) p.classList.remove('enter'); else { void p.getBoundingClientRect(); requestAnimationFrame(function () { p.classList.remove('enter'); }); }
      } else { rec.p.classList.remove('enter'); rec.p.setAttribute('d', d); }
      rec.p.style.d = "path('" + d + "')";
      var band = e.cls.indexOf('tool') > -1 ? 'tools' : (e.cls === 'pa' ? 'agents' : (e.cls.indexOf('rec') > -1 ? 'records' : 'work'));
      rec.p.classList.toggle('dim', !!(focus && !has(focus, band) && !(band === 'agents' && has(focus, 'people'))));
    });
    Object.keys(edgeMap).forEach(function (id) {
      if (eseen[id] || enterTimers[id]) return;
      var rec = edgeMap[id];
      if (reduce) { rec.p.remove(); delete edgeMap[id]; return; }
      rec.p.classList.add('enter');
      enterTimers[id] = setTimeout(function () { rec.p.remove(); delete edgeMap[id]; delete enterTimers[id]; }, 420);
    });
  }

  // ---------- the result ----------
  function approverOf(m) { return m.approver === 'the owner' ? 'You' : m.approver; }
  function day(m) {
    var ev = [], ap = approverOf(m), poss = ap === 'You' ? 'your' : ap + '\u2019s';
    if (m.wk.length) {
      var gates = uniq(m.wk.map(function (w) { return w.d.gate.toLowerCase(); }));
      ev.push({ t: '08:00', who: 'Needs you', x: ' holds ' + plural(m.wk.length, 'item', 'items') + ' for ' + ap + ': ' + gates.slice(0, 3).join(', ') + (gates.length > 3 ? ' and more' : '') + '. Each shows its exact words before it goes anywhere.' });
    }
    m.wk.forEach(function (w, i) {
      var T = w.d.day || { doT: [i % 2 ? '12:30' : '12:00', 'does the first pass on ' + w.name.toLowerCase() + '. It cannot send.'], yesT: [i % 2 ? '14:30' : '14:00', 'approves the {gate} before it leaves the team.'] };
      ev.push({ t: T.doT[0], who: w.d.agent[0], x: ' ' + T.doT[1] });
      ev.push({ t: T.yesT[0], who: ap, x: ' ' + T.yesT[1].replace('{gate}', w.d.gate.toLowerCase()) });
    });
    if (m.wk.length) ev.push({ t: '17:00', who: '', x: 'An agent step that cannot finish marks its task stuck with a plain reason. The reason sits at the top of ' + poss + ' Needs you the next morning.' });
    ev.sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
    return ev;
  }
  function renderDay(m) {
    var ul = doc.getElementById('res-day'); ul.textContent = '';
    var ev = day(m);
    if (!ev.length) { ul.appendChild(el('li', 'empty', 'Pick the work you repeat and the day writes itself: what each agent does, and what waits for a yes.')); return; }
    ev.forEach(function (e) {
      var li = el('li'); li.appendChild(el('time', '', e.t));
      if (e.who) li.appendChild(el('b', '', e.who));
      li.appendChild(doc.createTextNode(e.x)); ul.appendChild(li);
    });
  }
  function renderCounts(m) {
    var box = doc.getElementById('res-counts'); box.textContent = '';
    [[m.roles.length + 1, 'Members', 'You plus ' + plural(m.roles.length, 'role', 'roles')], [m.wk.length, 'Agents', 'one job each'], [m.rec.length, 'Record types', 'linked in a web'], [m.wk.length, 'Playbooks', 'one per kind of work'], [m.wk.length, 'Flows', 'each ends at the Gate']].forEach(function (c) {
      var d = el('div', 'cnt'); d.appendChild(el('b', '', String(c[0]))); d.appendChild(el('span', 'cn', c[1])); d.appendChild(el('span', 'cs', c[2])); box.appendChild(d);
    });
  }
  function renderTools(m) {
    var box = doc.getElementById('res-tools'); box.textContent = '';
    if (!m.tl.length) { box.appendChild(el('p', 'empty', 'Name the tools you use and this lists what Vyre does with each.')); return; }
    m.tl.forEach(function (t) {
      var d = el('div', 'tlc'); d.appendChild(el('b', '', t.name));
      var p = el('p'); p.appendChild(doc.createTextNode('Works with it today through a connection, plus a Flow web step or a custom module. '));
      p.appendChild(el('span', 'chip-next', 'Coming in 0.7')); p.appendChild(el('span', 'soon', t.planned ? 'A packaged Integration*' : 'An Integration built from its API*'));
      d.appendChild(p); box.appendChild(d);
    });
    box.appendChild(el('p', 'fnote', '*Where the vendor provides an API.'));
  }
  function renderGates(m) {
    var ul = doc.getElementById('res-gates'); ul.textContent = '';
    if (!m.nevers.length) { ul.appendChild(el('li', 'empty', 'Pick what must never go out without a yes.')); return; }
    m.nevers.forEach(function (n) { ul.appendChild(el('li', 'ap', n)); });
  }
  function renderPlay(m) {
    var box = doc.getElementById('res-play'); box.textContent = '';
    m.wk.forEach(function (w) {
      var c = el('div', 'pc'); c.appendChild(el('b', '', w.name));
      var st = el('p'); st.appendChild(el('span', 'k', 'Playbook ')); st.appendChild(doc.createTextNode(w.d.stages.join(' › '))); c.appendChild(st);
      var fl = el('ul', 'flow'); fl.appendChild(el('li', 'tr', w.d.trigger)); w.d.steps.forEach(function (s) { fl.appendChild(el('li', '', s)); });
      fl.appendChild(el('li', 'ap', 'Needs you: ' + w.d.gate + ' (' + approverOf(m) + ')')); c.appendChild(fl);
      box.appendChild(c);
    });
  }

  // ---------- prompts ----------
  function details(m) {
    var part = [], p = ind();
    part.push(p ? 'Industry: ' + p.name : 'Industry: not chosen');
    part.push('a team of ' + D.sizes[S.size]);
    if (m.roles.length) part.push('roles: ' + m.roles.join(', '));
    if (S.sel.things.length) part.push('we track: ' + S.sel.things.join(', '));
    if (S.sel.work.length) part.push('repeated work: ' + S.sel.work.join(', '));
    if (S.sel.tools.length) part.push('tools: ' + S.sel.tools.join(', '));
    if (m.nevers.length) part.push('never goes out without a yes: ' + m.nevers.join(', '));
    return ' About my business: ' + part.join('; ') + '.';
  }
  function buildPrompt(m) { return basePrompt + details(m) + ' When we agree on the map, set Vyre up for me over its MCP and build it: the record types, Playbooks and Flows, with everything that leaves the team held at the Gate for my yes.'; }

  // ---------- the guide ----------
  var panels = root.querySelectorAll('[data-step]'), progBtns = root.querySelectorAll('#prog button'), fill = doc.getElementById('prog-fill');
  var back = doc.getElementById('back'), next = doc.getElementById('next'), cnt = doc.getElementById('step-count'), hint1 = doc.getElementById('ind-need');
  function showStep(n, focus) {
    S.step = Math.max(0, Math.min(4, n));
    panels.forEach(function (p, i) { p.hidden = i !== S.step; });
    progBtns.forEach(function (b, i) { b.setAttribute('aria-current', i === S.step ? 'step' : 'false'); b.classList.toggle('done', i < S.step); });
    fill.style.width = ((S.step + 1) * 20) + '%';
    cnt.textContent = 'Step ' + (S.step + 1) + ' of 5 · ' + STEP_NAMES[S.step];
    back.disabled = S.step === 0;
    next.textContent = S.step === 4 ? 'See the result' : 'Next';
    next.disabled = S.step === 0 && !S.ind;
    if (hint1) hint1.hidden = !!S.ind;
    if (focus) { var h = panels[S.step].querySelector('h2'); if (h) h.focus({ preventScroll: true }); }
    update(false);
  }
  function buildChips(c) {
    var box = root.querySelector('[data-cat="' + c + '"]'); if (!box) return;
    box.textContent = '';
    opts(c).forEach(function (name) {
      var b = el('button', '', name); b.type = 'button'; b.setAttribute('aria-pressed', has(S.sel[c], name) ? 'true' : 'false');
      b.addEventListener('click', function () {
        S.touched = true;
        if (has(S.sel[c], name)) S.sel[c].splice(S.sel[c].indexOf(name), 1); else S.sel[c].push(name);
        b.setAttribute('aria-pressed', has(S.sel[c], name) ? 'true' : 'false'); update(true);
      });
      box.appendChild(b);
    });
  }
  function buildIndustry() {
    var box = doc.getElementById('ind-grid'); box.textContent = '';
    Object.keys(D.industries).forEach(function (k) {
      var b = el('button', '', D.industries[k].name); b.type = 'button'; b.setAttribute('aria-pressed', S.ind === k ? 'true' : 'false'); b.setAttribute('data-ind', k);
      b.addEventListener('click', function () {
        S.touched = true; setIndustry(k); buildIndustry(); CATS.forEach(buildChips); next.disabled = false; if (hint1) hint1.hidden = true; update(true);
        var nb = box.querySelector('[data-ind="' + k + '"]'); if (nb) nb.focus({ preventScroll: true });
      });
      box.appendChild(b);
    });
    var sb = doc.getElementById('size-grid'); sb.textContent = '';
    D.sizes.forEach(function (s, i) {
      var b = el('button', '', s); b.type = 'button'; b.setAttribute('aria-pressed', S.size === i ? 'true' : 'false');
      b.addEventListener('click', function () { S.touched = true; S.size = i; Array.prototype.forEach.call(sb.children, function (x, j) { x.setAttribute('aria-pressed', j === i ? 'true' : 'false'); }); update(true); });
      sb.appendChild(b);
    });
  }
  function addCustom(c) {
    var inp = root.querySelector('[data-add="' + c + '"]'), v = clean(inp.value);
    if (!v) return; inp.value = ''; S.touched = true;
    if (!has(opts(c), v)) S.extra[c].push(v);
    if (!has(S.sel[c], v)) S.sel[c].push(v);
    buildChips(c); update(true); inp.focus();
  }
  CATS.forEach(function (c) {
    var inp = root.querySelector('[data-add="' + c + '"]'), btn = root.querySelector('[data-addbtn="' + c + '"]');
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addCustom(c); } else if (e.key === 'Escape') inp.value = ''; });
    btn.addEventListener('click', function () { addCustom(c); });
  });
  back.addEventListener('click', function () { S.touched = true; showStep(S.step - 1, true); });
  next.addEventListener('click', function () {
    S.touched = true;
    if (S.step === 4) { toResult(); return; }
    showStep(S.step + 1, true);
  });
  progBtns.forEach(function (b, i) { b.addEventListener('click', function () { if (i > 0 && !S.ind) return; S.touched = true; showStep(i, true); }); });
  function toResult() {
    var r = doc.getElementById('result'); if (!r) return;
    S.touched = true; update(true);
    r.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    var h = doc.getElementById('res-h'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }
  doc.getElementById('skip').addEventListener('click', toResult);
  // in-page links keep the hash that holds the choices
  doc.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var t = doc.getElementById(a.getAttribute('href').slice(1)); if (!t) return;
      e.preventDefault(); t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
  });

  // ---------- copy and share ----------
  function copy(text, btn, label) {
    var old = btn.textContent;
    function done() { btn.textContent = label || 'Copied'; setTimeout(function () { btn.textContent = old; }, 1700); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    else { var ta = doc.createElement('textarea'); ta.value = text; doc.body.appendChild(ta); ta.select(); try { doc.execCommand('copy'); done(); } catch (e) {} ta.remove(); }
  }
  var buildBtn = doc.getElementById('act-build'), shareBtn = doc.getElementById('act-share'), buildPre = doc.getElementById('build-out');
  var lastModel = null;
  buildBtn.addEventListener('click', function () { copy(buildPrompt(lastModel || model()), buildBtn, 'Copied. Paste it into your agent'); });
  shareBtn.addEventListener('click', function () { S.touched = true; writeHash(); copy(location.href, shareBtn, 'Link copied'); });

  // ---------- the loop ----------
  var raf = 0;
  function update(write) {
    var m = model(); lastModel = m;
    out.textContent = basePrompt + details(m);
    if (buildPre) buildPre.textContent = buildPrompt(m);
    renderCounts(m); renderDay(m); renderTools(m); renderGates(m); renderPlay(m);
    var sum = doc.getElementById('dg-sum');
    if (sum) sum.textContent = plural(m.roles.length + 1, 'member', 'members') + ', ' + plural(m.wk.length, 'agent', 'agents') + ', ' + plural(m.rec.length, 'record type', 'record types') + ', ' + plural(m.wk.length, 'Playbook', 'Playbooks') + ', ' + plural(m.tl.length, 'tool', 'tools') + '.';
    if (wrap) { var W = wrap.clientWidth < 520 ? 340 : 720; cancelAnimationFrame(raf); raf = requestAnimationFrame(function () { apply(layout(m, W), STEP_FOCUS[S.step]); curW = W; }); }
    if (write !== false) writeHash();
  }
  if (wrap && window.ResizeObserver) new ResizeObserver(function () { var W = wrap.clientWidth < 520 ? 340 : 720; if (W !== curW && lastModel) { Object.keys(nodeMap).forEach(function (k) { nodeMap[k].g.remove(); }); Object.keys(edgeMap).forEach(function (k) { edgeMap[k].p.remove(); }); nodeMap = {}; edgeMap = {}; update(false); } }).observe(wrap);

  var loaded = readHash();
  buildIndustry(); CATS.forEach(buildChips);
  showStep(S.step, false);
  window.addEventListener('hashchange', function () { /* the share link opened in this tab */ if (readHash()) { buildIndustry(); CATS.forEach(buildChips); showStep(S.step, false); } });
  if (loaded) doc.documentElement.setAttribute('data-map-loaded', '1');
})();
