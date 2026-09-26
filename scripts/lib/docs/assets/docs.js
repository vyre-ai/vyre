// docs.vyre.run: the theme toggle, the navigation drawer, copy buttons on code, the "On this page"
// highlight, and search. Vanilla, no library. Written to assets/ with a content hash in its name by
// scripts/build-docs. Nothing here polls: every piece waits for an event.
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
  Array.prototype.forEach.call(document.querySelectorAll(".doc pre"), function (pre) {
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
      var code = pre.querySelector("code") || pre;
      copyText(code.textContent.replace(/\n$/, "")).then(function () {
        btn.textContent = "Copied";
      }, function () {
        btn.textContent = "Select and copy";
      }).then(function () {
        btn.classList.add("done");
        clearTimeout(timer);
        timer = setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600);
      });
    });
    wrap.appendChild(btn);
  });

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
      }).then(function (docs) {
        index = docs.map(function (d, order) {
          return {
            d: d, order: order,
            t: d.t.toLowerCase(),
            h: d.h.map(function (x) { return x[0].toLowerCase(); }),
            s: (d.d || "").toLowerCase(),
            b: d.b.toLowerCase(),
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

  // Title beats headings beats summary beats body. Every term has to match somewhere.
  function search(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length || !index) return [];
    var res = terms.map(wordStart);
    var out = [];
    for (var n = 0; n < index.length; n++) {
      var e = index[n];
      var score = 0;
      var hit = -1;
      var all = true;
      for (var k = 0; k < terms.length; k++) {
        var re = res[k];
        var s = 0;
        if (re.test(e.t)) s += e.t === terms[k] ? 40 : e.t.indexOf(terms[k]) === 0 ? 30 : 20;
        for (var j = 0; j < e.h.length; j++) {
          if (re.test(e.h[j])) { s += 8; if (hit < 0) hit = j; break; }
        }
        if (re.test(e.s)) s += 4;
        if (re.test(e.b)) s += 1;
        if (!s) { all = false; break; }
        score += s;
      }
      if (all) out.push({ e: e, score: score, hit: hit, terms: terms, res: res });
    }
    out.sort(function (a, b) { return b.score - a.score || a.e.order - b.e.order; });
    return out.slice(0, 10);
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
    var body = r.e.d.b;
    var m = r.res[0].exec(r.e.b);
    if (!m) return body.slice(0, 140);
    var at = m.index;
    var start = Math.max(0, at - 50);
    var text = body.slice(start, at + 110);
    return (start > 0 ? "…" : "") + text + (at + 110 < body.length ? "…" : "");
  }

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
      box.innerHTML = '<p class="r-empty">No page matches every word.</p>';
    } else {
      box.innerHTML = results.map(function (r, i) {
        var d = r.e.d;
        var url = d.u + (r.hit >= 0 ? "#" + encodeURIComponent(d.h[r.hit][1]) : "");
        return '<a id="q-r' + i + '" role="option" href="' + esc(url) + '" aria-selected="' + (i === sel) + '">' +
          '<span class="lbl">' + esc(d.s) + "</span>" +
          '<span class="r-t">' + highlight(d.t, r.res) + "</span>" +
          (r.hit >= 0 ? '<span class="r-h">' + highlight(d.h[r.hit][0], r.res) + "</span>" : "") +
          '<span class="r-x">' + highlight(snippet(r), r.res) + "</span></a>";
      }).join("");
    }
    open();
    select(sel);
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
      if (!box.hidden && links.length) { e.preventDefault(); window.location.href = links[Math.max(0, sel)].getAttribute("href"); close(); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!box.hidden) close(); else { input.value = ""; input.blur(); }
    }
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
