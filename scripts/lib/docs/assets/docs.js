// docs.vyre.run: the theme toggle, the navigation drawer, copy buttons on code, tabs, the "On this
// page" highlight, and search. Vanilla, no library. Written to assets/ with a content hash in its
// name by scripts/build-docs. Nothing here polls: every piece waits for an event. Every page works
// without it: tabs are stacked sections, output blocks are labelled, search is the only loss.
(function () {
  "use strict";
  var root = document.documentElement;
  var THEME_KEY = "vyre-docs-theme";

  function saved() { try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(THEME_KEY, v); } catch (e) {} }

  // ---- theme ----
  var themeBtn = document.querySelector(".theme");
  function labelTheme() {
    if (!themeBtn) return;
    var light = root.getAttribute("data-theme") === "light";
    themeBtn.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
    themeBtn.title = light ? "Dark theme" : "Light theme";
  }
  if (themeBtn) {
    labelTheme();
    themeBtn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      save(next);
      labelTheme();
    });
  }
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    var follow = function () {
      var s = saved();
      if (s === "light" || s === "dark") return;
      root.setAttribute("data-theme", mq.matches ? "light" : "dark");
      labelTheme();
    };
    if (mq.addEventListener) mq.addEventListener("change", follow);
  }

  // ---- navigation drawer (narrow screens) ----
  var menu = document.querySelector(".menu");
  var side = document.getElementById("sidebar");
  var scrim = document.querySelector(".scrim");
  function setNav(open) {
    document.body.classList.toggle("nav-open", open);
    if (menu) {
      menu.setAttribute("aria-expanded", String(open));
      menu.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    }
    if (scrim) scrim.hidden = !open;
  }
  if (menu && side) {
    menu.addEventListener("click", function () { setNav(!document.body.classList.contains("nav-open")); });
    if (scrim) scrim.addEventListener("click", function () { setNav(false); });
    side.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("a")) setNav(false); });
  }
  var current = side && side.querySelector('a[aria-current="page"]');
  if (current && side.scrollHeight > side.clientHeight) {
    side.scrollTop = Math.max(0, current.offsetTop - side.clientHeight / 3);
  }

  // ---- copy buttons ----
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error("copy failed"));
    });
  }
  // Spoken feedback for the copy buttons, which only change their text.
  var status = document.createElement("div");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  document.body.appendChild(status);
  // What a block copies: its text without `$ ` prompts (span.gp) or console output (span.go).
  function codeText(pre) {
    var code = (pre.querySelector("code") || pre).cloneNode(true);
    Array.prototype.forEach.call(code.querySelectorAll(".gp, .go"), function (el) { el.parentNode.removeChild(el); });
    return code.textContent.replace(/\n+$/, "");
  }
  Array.prototype.forEach.call(document.querySelectorAll(".doc pre"), function (pre) {
    if (pre.closest && pre.closest(".output")) return; // expected output: nothing to copy
    var wrap = document.createElement("div");
    wrap.className = "code-block";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy code");
    var timer = 0;
    btn.addEventListener("click", function () {
      copyText(codeText(pre)).then(function () {
        btn.textContent = "Copied";
        status.textContent = "Copied to the clipboard";
      }, function () {
        btn.textContent = "Select and copy";
        status.textContent = "Could not copy. Select the text and copy it.";
      }).then(function () {
        btn.classList.add("done");
        clearTimeout(timer);
        timer = setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("done"); status.textContent = ""; }, 1600);
      });
    });
    wrap.appendChild(btn);
  });

  // ---- tabs ----
  // `::: tabs` renders as stacked <section class="tab-panel" data-tab="Label">. Here each group
  // becomes a tab bar. Choosing a label switches every group on the page that has it, and is
  // remembered for the whole site: the most recent choices first, so each group takes the newest
  // one it offers.
  var TABS_KEY = "vyre-docs-tabs";
  function chosen() {
    try {
      var v = JSON.parse(localStorage.getItem(TABS_KEY) || "[]");
      return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string"; }) : [];
    } catch (e) { return []; }
  }
  function remember(label) {
    var list = chosen().filter(function (x) { return x !== label; });
    list.unshift(label);
    try { localStorage.setItem(TABS_KEY, JSON.stringify(list.slice(0, 12))); } catch (e) {}
  }
  var groups = [];
  Array.prototype.forEach.call(document.querySelectorAll(".doc .tabs"), function (el, g) {
    var panels = Array.prototype.filter.call(el.children, function (c) { return c.classList.contains("tab-panel"); });
    if (!panels.length) return;
    var bar = document.createElement("div");
    bar.className = "tablist";
    bar.setAttribute("role", "tablist");
    var group = { el: el, bar: bar, panels: panels, tabs: [], labels: [] };
    panels.forEach(function (panel, k) {
      var label = panel.getAttribute("data-tab") || "Option " + (k + 1);
      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab";
      tab.id = "tab-" + g + "-" + k;
      tab.textContent = label;
      tab.setAttribute("role", "tab");
      panel.id = panel.id || "tabpanel-" + g + "-" + k;
      tab.setAttribute("aria-controls", panel.id);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      panel.tabIndex = 0;
      tab.addEventListener("click", function () { choose(label, bar); });
      bar.appendChild(tab);
      group.tabs.push(tab);
      group.labels.push(label);
    });
    bar.setAttribute("aria-label", "Choose one: " + group.labels.join(", "));
    bar.addEventListener("keydown", function (e) {
      var i = group.tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var n = group.tabs.length, j = -1;
      if (e.key === "ArrowRight") j = (i + 1) % n;
      else if (e.key === "ArrowLeft") j = (i - 1 + n) % n;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = n - 1;
      if (j < 0) return;
      e.preventDefault();
      choose(group.labels[j], bar);
      group.tabs[j].focus();
    });
    el.insertBefore(bar, el.firstChild);
    el.classList.add("tabs-on");
    groups.push(group);
  });
  function show(group, k) {
    group.tabs.forEach(function (t, i) {
      t.setAttribute("aria-selected", String(i === k));
      t.tabIndex = i === k ? 0 : -1;
      group.panels[i].hidden = i !== k;
    });
  }
  // Pick a label everywhere. The tab bar that was clicked stays where it is on screen, even when
  // a group above it changes height.
  function choose(label, from) {
    var before = from ? from.getBoundingClientRect().top : 0;
    groups.forEach(function (gr) { var k = gr.labels.indexOf(label); if (k >= 0) show(gr, k); });
    if (from) {
      var moved = from.getBoundingClientRect().top - before;
      if (moved) window.scrollBy(0, moved);
      remember(label);
    }
  }
  function applyChosen() {
    var list = chosen();
    groups.forEach(function (gr) {
      var k = 0;
      for (var i = 0; i < list.length; i++) { var at = gr.labels.indexOf(list[i]); if (at >= 0) { k = at; break; } }
      show(gr, k);
    });
  }
  applyChosen();
  window.addEventListener("storage", function (e) { if (e.key === TABS_KEY) applyChosen(); });

  // An #anchor inside a hidden tab or a closed "why" opens it first, then scrolls to it.
  function reveal(id, scroll) {
    var el = id && document.getElementById(id);
    if (!el) return false;
    var hid = false;
    for (var p = el; p && p !== document.body; p = p.parentElement) {
      if (p.classList && p.classList.contains("tab-panel") && p.hidden) {
        hid = true;
        groups.forEach(function (gr) { var k = gr.panels.indexOf(p); if (k >= 0) show(gr, k); });
      } else if (p.tagName === "DETAILS" && !p.open && p !== el) { hid = true; p.open = true; }
    }
    if ((hid || scroll) && el.scrollIntoView) el.scrollIntoView();
    return true;
  }
  function hashId() { try { return decodeURIComponent(location.hash.slice(1)); } catch (e) { return location.hash.slice(1); } }
  if (location.hash) reveal(hashId(), false);
  window.addEventListener("hashchange", function () { reveal(hashId(), false); });

  // ---- "On this page": mark the section being read ----
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var heads = [];
    var linkFor = {};
    tocLinks.forEach(function (a) {
      var id = decodeURIComponent(a.hash.slice(1));
      var h = document.getElementById(id);
      if (h) { heads.push(h); linkFor[id] = a; }
    });
    var shown = {};
    var mark = function () {
      var active = null;
      for (var i = 0; i < heads.length; i++) if (shown[heads[i].id]) { active = heads[i]; break; }
      if (!active) {
        for (var j = 0; j < heads.length; j++) if (heads[j].getBoundingClientRect().top < 90) active = heads[j];
      }
      tocLinks.forEach(function (a) { a.classList.remove("active"); a.removeAttribute("aria-current"); });
      if (active && linkFor[active.id]) {
        linkFor[active.id].classList.add("active");
        linkFor[active.id].setAttribute("aria-current", "location");
      }
    };
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { shown[en.target.id] = en.isIntersecting; });
      mark();
    }, { rootMargin: "-60px 0px -55% 0px" });
    heads.forEach(function (h) { io.observe(h); });
  }

  // ---- search ----
  // search-index.json is { pages: [{ t, u, s, d }], items: [{ p, h, a, b }] }: one item for each
  // page's intro (h and a empty), each heading and each "If this happens" box, with its anchor.
  var input = document.getElementById("q");
  var box = document.getElementById("q-results");
  if (!input || !box) return;
  var index = null;
  var loading = null;
  var results = [];
  var sel = -1;

  function load() {
    if (index) return Promise.resolve(index);
    if (!loading) {
      loading = fetch("/search-index.json").then(function (r) {
        if (!r.ok) throw new Error("search index " + r.status);
        return r.json();
      }).then(function (data) {
        index = data.items.map(function (it, order) {
          var pg = data.pages[it.p];
          return {
            pg: pg, it: it, order: order,
            t: pg.t.toLowerCase(),
            h: it.h.toLowerCase(),
            s: it.a ? "" : (pg.d || "").toLowerCase(),
            b: it.b.toLowerCase(),
          };
        });
        return index;
      }).catch(function () { loading = null; return null; });
    }
    return loading;
  }

  function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  // A term matches at the start of a word: "cap" finds "Capsule", not "escape".
  function wordStart(t) { return new RegExp("(?:^|[^\\p{L}\\p{N}])" + reEscape(t), "u"); }

  // A heading that matches beats a page title that matches beats the words under it. Every term
  // has to match somewhere: in the heading, the page's title, the page's summary, or the text.
  // At most three items from one page, so one long page does not fill the list.
  function search(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length || !index) return [];
    var res = terms.map(wordStart);
    var out = [];
    for (var n = 0; n < index.length; n++) {
      var e = index[n];
      var score = 0;
      var all = true;
      for (var k = 0; k < terms.length; k++) {
        var re = res[k];
        var s = 0;
        if (e.h && re.test(e.h)) s += e.h === terms[k] ? 40 : e.h.indexOf(terms[k]) === 0 ? 30 : 20;
        if (re.test(e.t)) s += e.h ? 5 : e.t === terms[k] ? 36 : e.t.indexOf(terms[k]) === 0 ? 26 : 16;
        if (e.s && re.test(e.s)) s += 4;
        if (re.test(e.b)) s += 1;
        if (!s) { all = false; break; }
        score += s;
      }
      if (all) out.push({ e: e, score: score, res: res });
    }
    out.sort(function (a, b) { return b.score - a.score || a.e.order - b.e.order; });
    var per = {};
    return out.filter(function (r) {
      var u = r.e.pg.u;
      per[u] = (per[u] || 0) + 1;
      return per[u] <= 3;
    }).slice(0, 10);
  }

  function highlight(text, res) {
    var html = esc(text);
    res.forEach(function (re) {
      var src = re.source.replace("(?:^|[^\\p{L}\\p{N}])", "");
      html = html.replace(new RegExp("(^|[^\\p{L}\\p{N}])(" + src + ")", "giu"), "$1<mark>$2</mark>");
    });
    return html;
  }

  function snippet(r) {
    var body = r.e.it.b || r.e.pg.d || "";
    var m = r.res[0].exec(r.e.b);
    if (!m) return body.slice(0, 140) + (body.length > 140 ? "…" : "");
    var at = m.index;
    var start = Math.max(0, at - 50);
    var text = body.slice(start, at + 110);
    return (start > 0 ? "…" : "") + text + (at + 110 < body.length ? "…" : "");
  }

  function hrefOf(r) { return r.e.pg.u + (r.e.it.a ? "#" + encodeURIComponent(r.e.it.a) : ""); }

  function render() {
    var q = input.value.trim();
    if (!q) { close(); return; }
    if (!index) {
      box.innerHTML = '<p class="r-empty">Loading the index…</p>';
      open();
      return;
    }
    results = search(q);
    sel = results.length ? 0 : -1;
    if (!results.length) {
      box.innerHTML = '<p class="r-empty">Nothing matches every word.</p>';
    } else {
      box.innerHTML = results.map(function (r, i) {
        var pg = r.e.pg;
        return '<a id="q-r' + i + '" role="option" href="' + esc(hrefOf(r)) + '" aria-selected="' + (i === sel) + '">' +
          '<span class="lbl">' + esc(pg.s) + "</span>" +
          '<span class="r-t">' + highlight(pg.t, r.res) + "</span>" +
          (r.e.it.h ? '<span class="r-h">' + highlight(r.e.it.h, r.res) + "</span>" : "") +
          '<span class="r-x">' + highlight(snippet(r), r.res) + "</span></a>";
      }).join("");
    }
    open();
    select(sel);
  }

  // Go to a result. On this page, a hash change is enough (and opens a tab if it has to).
  function go(href) {
    var a = document.createElement("a");
    a.href = href;
    close();
    if (a.pathname === location.pathname && a.hash) {
      input.blur();
      if (a.hash === location.hash) reveal(hashId(), true); else location.hash = a.hash;
      return;
    }
    window.location.href = href;
  }

  function open() { box.hidden = false; input.setAttribute("aria-expanded", "true"); }
  function close() {
    box.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    sel = -1;
  }
  function select(i) {
    var links = box.querySelectorAll("a");
    if (!links.length) return;
    sel = (i + links.length) % links.length;
    Array.prototype.forEach.call(links, function (a, k) { a.setAttribute("aria-selected", String(k === sel)); });
    input.setAttribute("aria-activedescendant", "q-r" + sel);
    var el = links[sel];
    if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("focus", function () { load().then(function () { if (input.value.trim()) render(); }); });
  input.addEventListener("input", function () {
    render();
    load().then(function (ix) {
      if (document.activeElement !== input || !input.value.trim()) return;
      if (ix) { render(); return; }
      box.innerHTML = '<p class="r-empty">Search did not load. Check the connection and type again.</p>';
      open();
    });
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); if (box.hidden) render(); else select(sel + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(sel - 1); }
    else if (e.key === "Enter") {
      var links = box.querySelectorAll("a");
      if (!box.hidden && links.length) { e.preventDefault(); go(links[Math.max(0, sel)].getAttribute("href")); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!box.hidden) close(); else { input.value = ""; input.blur(); }
    }
  });
  box.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    go(a.getAttribute("href"));
  });
  document.addEventListener("click", function (e) {
    if (!box.hidden && !e.target.closest(".search")) close();
  });
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    if ((e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === "Escape" && document.body.classList.contains("nav-open")) {
      setNav(false);
      if (menu) menu.focus();
    }
  });
})();
