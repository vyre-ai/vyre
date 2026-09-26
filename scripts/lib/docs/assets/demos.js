// docs.vyre.run demo widgets. Loaded only by pages with a `::: demo name` block (scripts/build-docs
// links it with a content hash in its name). Each widget replaces the Markdown fallback inside
// <div class="demo" data-demo="name">; without this script, or with an unknown name, the fallback
// stays. Vanilla, no library, nothing polls, nothing is sent anywhere: the data is the made-up
// sample world (alex, Harlow Legal, Northwind Bakery, juno, kit).
//
//   capsule      a Capsule you can type into: results, @ completion, sums, memory in gold
//   onboarding   the fallback's list of screenshots as Back/Next slides named by step
(function () {
  "use strict";

  /** A tiny element builder: h("div", { class: "x", onclick: fn }, child, "text", [more]). */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { add(el, k); }); return; }
    el.appendChild(typeof kid === "object" ? kid : document.createTextNode(String(kid)));
  }
  var uid = 0;
  function nextId(p) { uid += 1; return "vd-" + p + "-" + uid; }

  // ---------------------------------------------------------------- capsule

  // The Capsule's own drawings (local/capsule/app/capsule.js), on the 16 grid.
  var GLYPHS = {
    agent: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5c.6-2.6 2.4-4 4.5-4s3.9 1.4 4.5 4"/>',
    assistant: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5c.6-2.6 2.4-4 4.5-4s3.9 1.4 4.5 4"/><circle cx="13" cy="3" r="1.6" fill="#C6F36B" stroke="none"/>',
    project: '<path d="M2 4.5h4l1.5 1.5H14v7H2z"/>',
    thread: '<path d="M3 4.5l3 3.5-3 3.5"/><path d="M8 11.5h5"/>',
    memory: '<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M6 8h4M6 11h4"/>',
    vault: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    boxfile: '<rect x="2.5" y="3" width="11" height="4" rx="1"/><rect x="2.5" y="9" width="11" height="4" rx="1"/><path d="M5 5h.01M5 11h.01"/>',
    quick: '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2L12 12M12 4l-1.8 1.8M5.8 10.2L4 12"/>',
    calc: '<path d="M4 6h8M4 10h8"/>',
  };
  var TONE = { memory: "#EBC76B", quick: "#C6F36B", calc: "#C6F36B" };
  var KIND = { agent: "Agent", assistant: "Assistant", project: "Project", thread: "Thread", memory: "Memory", vault: "Vault", boxfile: "Box" };
  var MARK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4L8 13L11.52 7.24" stroke="#F1EEE6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13.5" cy="4" r="1.8" fill="#C6F36B"/></svg>';

  function glyph(kind) {
    var cls = "vd-ic" + (kind === "memory" ? " gold" : "");
    return h("span", { class: cls, "aria-hidden": "true", html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="' + (TONE[kind] || "#F1EEE6") +
      '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + (GLYPHS[kind] || GLYPHS.memory) + "</svg>" });
  }

  // The sample world. `keys` are extra words a result answers to.
  var WORLD = [
    { kind: "assistant", label: "juno", sub: "Your assistant", keys: "assistant", open: "Opens a direct message with juno." },
    { kind: "agent", label: "kit", sub: "Agent · Harlow Legal", keys: "agent", open: "Opens a direct message with kit." },
    { kind: "project", label: "Harlow Legal", sub: "3 threads · kit", keys: "law firm", open: "Opens the Harlow Legal project in the Deck." },
    { kind: "project", label: "Northwind Bakery", sub: "2 threads · juno", keys: "bakery", open: "Opens the Northwind Bakery project in the Deck." },
    { kind: "thread", label: "Intake emails", sub: "Harlow Legal", keys: "harlow intake", open: "Opens the Intake emails thread." },
    { kind: "thread", label: "New client checklist", sub: "Harlow Legal", keys: "harlow", open: "Opens the New client checklist thread." },
    { kind: "thread", label: "Weekly orders", sub: "Northwind Bakery", keys: "northwind", open: "Opens the Weekly orders thread." },
    { kind: "memory", label: "Northwind Bakery delivers on Tuesdays and Fridays", sub: "Weekly orders · March", keys: "delivery deliver when days",
      answer: "Tuesdays and Fridays, before 9 am.", open: "Shows the turn this came from, in Weekly orders." },
    { kind: "memory", label: "Harlow Legal wants intake replies within one day", sub: "Intake emails · April", keys: "promise promised reply replies how long",
      answer: "A reply to every intake email within one working day.", open: "Shows the turn this came from, in Intake emails." },
    { kind: "vault", label: "Harlow Legal login", sub: "Vault · kit may use it", keys: "password", open: "Fills the Harlow Legal login into the app you were in. The password never shows." },
    { kind: "vault", label: "Northwind Bakery orders key", sub: "Vault", keys: "api key token", open: "Fills the Northwind Bakery orders key where your cursor was." },
    { kind: "boxfile", label: "harlow-legal-retainer.pdf", sub: "Box · Harlow Legal", keys: "retainer file", open: "Opens harlow-legal-retainer.pdf from your box." },
    { kind: "boxfile", label: "northwind-menu.md", sub: "Box · Northwind Bakery", keys: "menu file", open: "Opens northwind-menu.md from your box." },
  ];
  var AT = WORLD.filter(function (r) { return r.kind === "assistant" || r.kind === "agent" || r.kind === "project" || r.kind === "thread"; });

  function terms(q) { return q.toLowerCase().replace(/[?!.,']/g, " ").split(/\s+/).filter(function (t) { return t.length > 1 || /\d/.test(t); }); }
  function wordStart(hay, t) { return (" " + hay.toLowerCase().replace(/[^a-z0-9]+/g, " ")).indexOf(" " + t) >= 0; }
  var STOP = { what: 1, when: 1, who: 1, where: 1, why: 1, how: 1, does: 1, do: 1, did: 1, is: 1, are: 1, the: 1, to: 1, on: 1, in: 1, my: 1, me: 1, of: 1, for: 1, and: 1, can: 1, should: 1, we: 1, it: 1, a: 1 };
  function isQuestion(q) { return /\?\s*$/.test(q) || /^(what|when|who|where|why|how|does|do|did|is|are|can|should)\b/i.test(q.trim()); }

  /** Results for plain words: every meaningful word has to start a word in the result. */
  function find(q) {
    var ts = terms(q).filter(function (t) { return !STOP[t]; });
    if (!ts.length) return [];
    var q1 = isQuestion(q);
    return WORLD.filter(function (r) {
      var hay = r.label + " " + r.sub + " " + r.keys;
      var hits = ts.filter(function (t) { return wordStart(hay, t); }).length;
      // A question only needs most of its words to match a memory; a lookup needs all of them.
      return q1 ? (r.kind === "memory" ? hits >= Math.min(2, ts.length) : hits === ts.length) : hits === ts.length;
    }).slice(0, 6);
  }

  /** A sum, the Capsule's calculator row. No eval: a small parser for + - * / ( ). */
  function calc(s) {
    var src = s.replace(/[x×]/g, "*");
    if (!/^[\d\s.+\-*/()]+$/.test(src) || !/\d\s*[-+*/]\s*[\d(-]/.test(src)) return null;
    var i = 0;
    function ws() { while (src[i] === " ") i++; }
    function atom() {
      ws();
      if (src[i] === "(") { i++; var v = expr(); ws(); if (src[i] !== ")") throw 0; i++; return v; }
      if (src[i] === "-") { i++; return -atom(); }
      var m = /^\d*\.?\d+/.exec(src.slice(i));
      if (!m) throw 0;
      i += m[0].length;
      return parseFloat(m[0]);
    }
    function term() { var v = atom(); for (;;) { ws(); var c = src[i]; if (c !== "*" && c !== "/") return v; i++; var r = atom(); v = c === "*" ? v * r : v / r; } }
    function expr() { var v = term(); for (;;) { ws(); var c = src[i]; if (c !== "+" && c !== "-") return v; i++; var r = term(); v = c === "+" ? v + r : v - r; } }
    try { var v = expr(); ws(); return i === src.length && isFinite(v) ? Math.round(v * 1e10) / 1e10 : null; } catch (e) { return null; }
  }

  function capsule(el) {
    var S = { chip: null, sel: 0, view: "list", rows: [], said: null };
    var listId = nextId("list");
    var input = h("input", {
      type: "text", autocomplete: "off", spellcheck: "false", placeholder: "Ask, or @agent",
      role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": listId,
      "aria-label": "Capsule demo: ask, or @ an agent, project or thread",
    });
    var chip = h("span", { class: "vd-chip", hidden: true });
    var hint = h("span", { class: "vd-hint" });
    var panel = h("div", { class: "vd-panel", id: listId, role: "listbox", "aria-label": "Results" });
    var keys = h("div", { class: "vd-keys", "aria-hidden": "true" });
    var live = h("div", { class: "vd-sr", role: "status" });
    var cap = h("div", { class: "vd-cap" },
      h("div", { class: "vd-bar", onmousedown: function (e) { if (e.target !== input) { e.preventDefault(); input.focus(); } } },
        h("span", { class: "vd-mark", html: MARK }), h("div", { class: "vd-field" }, chip, input), hint),
      panel, keys, live);
    var tries = ["north", "@kit", "12 * 18", "when does Northwind Bakery deliver?"];
    var note = h("p", { class: "vd-note" }, "A demo with made-up data; nothing is sent. Try ",
      tries.map(function (t, i) {
        return [i ? (i === tries.length - 1 ? " or " : ", ") : "", h("button", { type: "button", class: "vd-try", onclick: function () { S.chip = null; input.value = t; S.view = "list"; paint(); input.focus(); } }, t)];
      }), ".");
    var wrap = h("div", { class: "vd-capwrap" }, cap, note);

    function keyline() { keys.textContent = ""; for (var i = 0; i < arguments.length; i++) if (arguments[i]) keys.appendChild(h("span", null, arguments[i])); }
    function sect(cls) { var s = h("div", { class: "vd-sect " + cls }); for (var i = 1; i < arguments.length; i++) add(s, arguments[i]); return s; }

    /** The rows for what is in the box now. */
    function rowsFor(q) {
      if (!S.chip && q.charAt(0) === "@") {
        var w = q.slice(1).toLowerCase();
        return AT.filter(function (r) { return !w || wordStart(r.label + " " + r.sub, w); }).map(function (r) { return { at: r }; });
      }
      if (!q) return [];
      if (S.chip) {
        var c = S.chip;
        return [{ ask: c.label, sub: c.kind === "project" ? "a new thread in " + c.label : c.kind === "thread" ? "types into this session as you, in " + c.sub : "in its current thread" }];
      }
      var sum = calc(q);
      if (sum !== null) return [{ calc: sum, q: q }];
      var found = find(q).map(function (r) { return { r: r }; });
      var own = found.length > 0;
      var asks = isQuestion(q) && !own
        ? [{ ask: "Claude", quick: true, sub: "haiku, a fast model" }, { ask: "juno", sub: "your assistant, with your memory" }]
        : [{ ask: "juno", sub: own ? "your assistant, with your memory" : "your assistant, which can act" }];
      // Memory that answers a question is shown above, in gold, not again as a row.
      var m = memo(q);
      if (m) found = found.filter(function (x) { return x.r !== m; });
      return isQuestion(q) || !found.length ? asks.concat(found) : found.concat(asks);
    }

    function memo(q) {
      if (!isQuestion(q) || S.chip) return null;
      var hit = find(q).filter(function (r) { return r.kind === "memory"; })[0];
      return hit || null;
    }

    function rowEl(row, i) {
      var on = i === S.sel;
      var id = listId + "-" + i;
      var pick = function (e) { e.preventDefault(); S.sel = i; take(); };
      var hover = function () { if (S.sel !== i) { S.sel = i; mark(); } };
      if (row.at) {
        return h("div", { class: "vd-row" + (on ? " on" : ""), id: id, role: "option", "aria-selected": String(on), onmousedown: pick, onmousemove: hover },
          h("span", { class: "vd-lbl vd-kind" }, KIND[row.at.kind].toLowerCase()), h("span", { class: "vd-t" }, row.at.label), h("span", { class: "vd-s" }, row.at.sub));
      }
      if (row.calc !== undefined) {
        return h("div", { class: "vd-row res calc" + (on ? " on" : ""), id: id, role: "option", "aria-selected": String(on), onmousedown: pick, onmousemove: hover },
          glyph("calc"), h("span", { class: "vd-t" }, "= " + row.calc), h("span", { class: "vd-s" }, row.q), h("span", { class: "vd-acc" }, on ? "copy ⏎" : ""));
      }
      if (row.ask) {
        return h("div", { class: "vd-row res ask" + (on ? " on" : ""), id: id, role: "option", "aria-selected": String(on), onmousedown: pick, onmousemove: hover },
          glyph(row.quick ? "quick" : row.ask === "juno" ? "assistant" : S.chip ? S.chip.kind : "agent"),
          h("span", { class: "vd-t" }, "Ask " + row.ask), h("span", { class: "vd-s" }, row.sub), h("span", { class: "vd-acc" }, on ? "⏎" : i === 0 ? "⇥" : ""));
      }
      var r = row.r;
      return h("div", { class: "vd-row res" + (on ? " on" : ""), id: id, role: "option", "aria-selected": String(on), onmousedown: pick, onmousemove: hover },
        glyph(r.kind), h("span", { class: "vd-t" }, r.label), h("span", { class: "vd-s" }, r.sub), h("span", { class: "vd-acc" }, on ? "⏎" : KIND[r.kind]));
    }

    /** Move the highlight without rebuilding the rows. */
    function mark() {
      var rows = panel.querySelectorAll("[role=option]");
      for (var i = 0; i < rows.length; i++) {
        var on = i === S.sel;
        rows[i].classList.toggle("on", on);
        rows[i].setAttribute("aria-selected", String(on));
        var acc = rows[i].querySelector(".vd-acc");
        var row = S.rows[i];
        if (acc && row) acc.textContent = on ? (row.calc !== undefined ? "copy ⏎" : "⏎") : row.r ? KIND[row.r.kind] : row.ask && i === 0 ? "⇥" : "";
      }
      if (rows[S.sel]) input.setAttribute("aria-activedescendant", rows[S.sel].id); else input.removeAttribute("aria-activedescendant");
    }

    function paint() {
      var q = input.value.trim();
      panel.textContent = "";
      hint.textContent = "";
      chip.hidden = !S.chip;
      chip.textContent = S.chip ? S.chip.label : "";
      input.placeholder = S.chip ? "Ask " + S.chip.label : "Ask, or @agent";

      if (S.view === "said") {
        var said = S.said;
        panel.appendChild(sect("vd-replyhead", h("span", { class: "vd-lbl on" }, said.head), h("span", { class: "vd-who" }, said.who)));
        if (said.gold) panel.appendChild(sect("vd-recall memo", h("span", { class: "vd-lbl" }, "From memory · no model used"), h("div", { class: "vd-answer" }, said.gold.answer),
          h("div", { class: "vd-src" }, glyph("memory"), said.gold.sub)));
        panel.appendChild(sect("vd-reply", said.text));
        keyline("esc back");
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
        live.textContent = said.head + ". " + (said.gold ? said.gold.answer + " " : "") + said.text;
        return;
      }

      S.rows = rowsFor(q);
      if (S.sel >= S.rows.length) S.sel = 0;
      var m = memo(q);
      if (m) {
        hint.appendChild(h("span", { class: "vd-ms" }, "4 ms"));
        panel.appendChild(sect("vd-recall memo", h("span", { class: "vd-lbl" }, "From memory · no model used"), h("div", { class: "vd-answer" }, m.answer),
          h("div", { class: "vd-src" }, glyph("memory"), m.label + " · " + m.sub)));
      }
      if (S.rows.length) {
        var pad = sect("vd-pad");
        S.rows.forEach(function (row, i) { pad.appendChild(rowEl(row, i)); });
        panel.appendChild(pad);
      } else if (q.charAt(0) === "@") {
        panel.appendChild(sect("vd-note-in", "No agent, project or thread by that name."));
      } else if (!q && !S.chip) {
        panel.appendChild(sect("vd-note-in", "Type to find agents, projects, threads, notes and logins, or ask juno. @ names one."));
      }
      input.setAttribute("aria-expanded", String(S.rows.length > 0));
      mark();
      var cur = S.rows[S.sel];
      if (q.charAt(0) === "@" && !S.chip) keyline("↑↓ move", "⏎ choose", "esc close");
      else if (!q) keyline(S.chip ? "⌫ leave" : "⏎ ask juno", S.chip ? null : "@ agent, project or thread", "esc close");
      else keyline("↑↓ move", !cur ? null : cur.ask ? "⏎ send" : cur.calc !== undefined ? "⏎ copy" : "⏎ open", cur && !cur.ask && S.rows.some(function (r) { return r.ask; }) ? "⇥ send" : null, "esc close");
      live.textContent = S.rows.length ? S.rows.length + (S.rows.length === 1 ? " result" : " results") : "";
    }

    /** Enter, or a click: do what the highlighted row says. */
    function take(forceAsk) {
      var q = input.value.trim();
      var row = forceAsk ? S.rows.filter(function (r) { return r.ask; })[0] : S.rows[S.sel];
      if (!row) return;
      if (row.at) { S.chip = row.at; input.value = ""; S.sel = 0; paint(); return; }
      if (row.calc !== undefined) { S.said = { head: "Copied", who: String(row.calc), text: "In Vyre, Enter copies " + row.calc + " to the clipboard." }; }
      else if (row.ask) {
        var gold = S.chip ? null : memo(q);
        var who = row.ask + (S.chip && S.chip.kind === "thread" ? " · " + S.chip.sub : "");
        S.said = { head: "Answer", who: who, gold: gold,
          text: gold ? gold.label + ". That came from your notes, so juno did not need a model for it."
            : "This is a demo, so nothing was sent. In Vyre, " + row.ask + " answers here, in place, with a copy button and what it cost." };
      } else {
        S.said = { head: KIND[row.r.kind], who: row.r.label, text: row.r.open };
      }
      S.view = "said";
      paint();
    }

    input.addEventListener("input", function () { S.view = "list"; S.sel = 0; paint(); });
    input.addEventListener("keydown", function (e) {
      var k = e.key;
      if (S.view === "said") {
        if (k === "Escape" || k === "Enter") { e.preventDefault(); S.view = "list"; paint(); }
        return;
      }
      if (k === "ArrowDown" || k === "ArrowUp") {
        if (!S.rows.length) return;
        e.preventDefault();
        S.sel = (S.sel + (k === "ArrowDown" ? 1 : -1) + S.rows.length) % S.rows.length;
        mark();
      } else if (k === "Enter") { e.preventDefault(); take(false); }
      else if (k === "Tab" && input.value.trim() && S.rows.some(function (r) { return r.ask; })) { e.preventDefault(); take(true); }
      else if (k === "Escape") {
        if (input.value) { e.preventDefault(); input.value = ""; S.sel = 0; paint(); }
        else if (S.chip) { e.preventDefault(); S.chip = null; paint(); }
      } else if (k === "Backspace" && S.chip && !input.value) { e.preventDefault(); S.chip = null; paint(); }
    });
    paint();
    // Built and painted first, so a failure leaves the fallback in place.
    el.textContent = "";
    el.appendChild(wrap);
  }

  // ---------------------------------------------------------------- onboarding

  /** A step's name: its screenshot's title, else the item's own words, else the alt text. */
  function stepName(li, img, i) {
    var cap = li.querySelector("figcaption");
    var alt = img.getAttribute("alt") || "";
    if (cap && cap.textContent.trim() && cap.textContent.trim() !== alt) return cap.textContent.trim();
    var clone = li.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll("figure, img, ul, ol"), function (x) { x.parentNode.removeChild(x); });
    var own = clone.textContent.replace(/\s+/g, " ").trim().replace(/[.:]$/, "");
    return own || alt || "Step " + (i + 1);
  }

  function onboarding(el) {
    var list = el.querySelector("ol, ul");
    if (!list) return;
    var items = Array.prototype.filter.call(list.children, function (li) { return li.tagName === "LI" && li.querySelector("img"); });
    if (items.length < 2) return;
    var steps = items.map(function (li, i) {
      var img = li.querySelector("img");
      var name = stepName(li, img, i);
      var shot = li.querySelector("figure") || h("figure", { class: "shot" }, Array.prototype.slice.call(li.querySelectorAll("img")));
      var cap = shot.querySelector("figcaption");
      if (cap && cap.textContent.trim() === name) cap.hidden = true;
      return { name: name, slide: h("div", { class: "vd-slide", role: "group", "aria-roledescription": "slide", "aria-label": (i + 1) + " of " + items.length + ": " + name }, shot) };
    });
    var at = 0;
    var count = h("span", { class: "vd-count" });
    var name = h("span", { class: "vd-name" });
    var back = h("button", { type: "button", class: "vd-btn", onclick: function () { go(at - 1); } }, "Back");
    var next = h("button", { type: "button", class: "vd-btn primary", onclick: function () { go(at + 1); } }, "Next");
    var dots = steps.map(function (s, i) {
      return h("button", { type: "button", class: "vd-dot", "aria-label": "Step " + (i + 1) + ": " + s.name, onclick: function () { go(i); } });
    });
    var stage = h("div", { class: "vd-stage" }, steps.map(function (s) { return s.slide; }));
    var box = h("div", { class: "vd-steps", role: "region", "aria-roledescription": "carousel", "aria-label": "Onboarding, one screen at a time" },
      h("div", { class: "vd-head", "aria-live": "polite" }, count, name),
      stage,
      h("div", { class: "vd-nav" }, back, h("div", { class: "vd-dots" }, dots), next));
    box.addEventListener("keydown", function (e) {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight") { e.preventDefault(); go(at + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(at - 1); }
    });
    function go(i) {
      if (i < 0 || i >= steps.length) return;
      var hadFocus = box.contains(document.activeElement) ? document.activeElement : null;
      at = i;
      steps.forEach(function (s, k) { s.slide.hidden = k !== at; });
      dots.forEach(function (d, k) { if (k === at) d.setAttribute("aria-current", "step"); else d.removeAttribute("aria-current"); });
      count.textContent = "Step " + (at + 1) + " of " + steps.length;
      name.textContent = steps[at].name;
      back.disabled = at === 0;
      next.disabled = at === steps.length - 1;
      // A button that just went disabled would drop focus to the page: keep it in the widget.
      if (hadFocus && hadFocus.disabled) (at === 0 ? next : back).focus();
    }
    go(0);
    list.parentNode.replaceChild(box, list);
  }

  var WIDGETS = { capsule: capsule, onboarding: onboarding };
  Array.prototype.forEach.call(document.querySelectorAll(".demo[data-demo]"), function (el) {
    var w = WIDGETS[el.getAttribute("data-demo")];
    if (!w) return;
    try { w(el); el.classList.add("demo-on"); } catch (e) { /* the fallback stays */ }
  });
})();
