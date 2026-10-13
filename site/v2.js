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

  // The mark's dots find their way into the V. Each dot starts away from its place and settles; in the far spread (the 404 page) the dots
  // start well outside the card and a few stay adrift. A visitor who asks for less motion gets the settled mark.
  doc.querySelectorAll('svg.vmark.assemble').forEach(function (svg) {
    if (reduce) return;
    var far = svg.getAttribute('data-spread') === 'far', adrift = +svg.getAttribute('data-adrift') || 0;
    var NS = 'http://www.w3.org/2000/svg', clip = svg.querySelector('g[clip-path]'), cs = [].slice.call(svg.querySelectorAll('circle'));
    if (far) {
      var free = doc.createElementNS(NS, 'g'); clip.parentNode.insertBefore(free, clip.nextSibling);
      cs.forEach(function (c) { free.appendChild(c); }); svg.style.overflow = 'visible';
    }
    var lost = {}; for (var k = 0; k < adrift; k++) lost[Math.floor(Math.random() * cs.length)] = 1;
    cs.forEach(function (c, i) {
      var a = Math.random() * 6.2832, d = far ? 22 + Math.random() * 64 : 4 + Math.random() * 14, was = c.getAttribute('fill');
      c._to = 'translate(' + (Math.cos(a) * d).toFixed(1) + 'px,' + (Math.sin(a) * d).toFixed(1) + 'px)';
      c._was = was; c._lost = !!lost[i];
      c.style.transform = c._to; c.style.opacity = '0';
      if (far && was !== '#B8A4FF') c.style.fill = 'var(--ink-3)';
    });
    function go() {
      cs.forEach(function (c, i) {
        var delay = (far ? 200 : 0) + Math.random() * (far ? 1800 : 700);
        if (c._lost) { c.style.transition = 'transform 2.4s cubic-bezier(.2,.7,.2,1) ' + delay + 'ms, opacity 1s ' + delay + 'ms'; c.style.transform = c._to.replace(/-?\d+\.\d/g, function (n) { return (n * .55).toFixed(1); }); c.style.opacity = '.7'; c.classList.add('adrift'); c.style.animationDelay = (Math.random() * -6).toFixed(1) + 's'; return; }
        c.style.transition = 'transform ' + (far ? 2.6 : 1.5) + 's cubic-bezier(.2,.7,.2,1) ' + delay + 'ms, opacity .8s ' + delay + 'ms, fill 1.4s ease ' + (delay + 900) + 'ms';
        c.style.transform = 'none'; c.style.opacity = '1'; if (far && c._was !== '#B8A4FF') c.style.fill = c._was;
      });
    }
    if ('IntersectionObserver' in window) { var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { io.disconnect(); requestAnimationFrame(function () { requestAnimationFrame(go); }); } }); io.observe(svg); } else go();
  });

  // Scroll-linked screens, for a browser without scroll-driven animation: move each tall capture by the page scroll, on the same ranges the CSS uses.
  if (!reduce && !(window.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()'))) {
    var shots = [].slice.call(doc.querySelectorAll('.ss')), queued = false;
    var clamp = function (v) { return Math.max(0, Math.min(1, v)); };
    var move = function () {
      queued = false; var vh = window.innerHeight;
      shots.forEach(function (el) {
        var r = el.getBoundingClientRect(), phone = el.classList.contains('ss-p'), hero = el.classList.contains('ss-hero'), p;
        if (hero) p = clamp(window.scrollY / (phone ? 1000 : 760));
        else { var t = (vh - r.top) / (vh + r.height); p = phone ? clamp(t) : clamp((t - .08) / .70); }
        [].forEach.call(el.querySelectorAll('img'), function (im) { var travel = im.offsetHeight - el.clientHeight; if (travel > 0) im.style.transform = 'translateY(' + (-p * travel).toFixed(1) + 'px)'; });
      });
    };
    var ask = function () { if (!queued) { queued = true; requestAnimationFrame(move); } };
    window.addEventListener('scroll', ask, { passive: true }); window.addEventListener('resize', ask); window.addEventListener('load', ask); ask();
  }
  function paintAll() { painters.forEach(function (p) { p(); }); }
  doc.querySelectorAll('canvas.field').forEach(field);
  doc.querySelectorAll('canvas.markart').forEach(mark);
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(paintAll, 150); });
})();
