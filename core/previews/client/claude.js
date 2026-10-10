// Vyre's preview runtime: the page global `claude` with `.use(name)`, shaped like Claude's artifact runtime (contract 0.2.75) so a page written for it runs here unchanged. This file is served by the preview's own origin at
// /__vyre/claude.js, only to a page that declared capabilities. Nothing here runs until the page asks: `use(name)` answers null for a capability the page did not declare or the viewer refused, and each declared
// one asks the viewer at its first use. It adds nothing to the page's own code and takes nothing away. Plain browser JavaScript, no dependencies.
(function () {
  "use strict";
  // the global is named as a page written for the artifact runtime already expects
  var NAME = "claude";
  if (window[NAME] && typeof window[NAME].use === "function") return;
  var API = "/__vyre/api";
  var meta = null, metaP = null;
  var WORDS = {
    db: "store and share its own data on this server",
    user: "know who you are on this page (a name and an id that only this page uses)",
    sample: "ask the model on this server for text",
    downloads: "offer files for you to save"
  };

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function post(op, args) {
    return fetch(API, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-page-bridge": "1" }, body: JSON.stringify({ op: op, args: args || {} }) })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (j) { if (!j || j.error) throw err(j && j.error ? j.error.code : "unavailable", j && j.error ? j.error.message : "the page's server did not answer"); return j.data; });
  }
  function loadMeta() { if (!metaP) metaP = post("caps").then(function (m) { meta = m; return m; }, function () { meta = null; return null; }); return metaP; }

  // ---- the viewer's yes -------------------------------------------------------------------------------------------------------------------------------------------------------------
  function dialog(title, body, buttons) {
    return new Promise(function (resolve) {
      var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      var bg = dark ? "#1b1b1a" : "#ffffff", fg = dark ? "#f3f1ec" : "#171716", mut = dark ? "#a8a59d" : "#5d5b55", edge = dark ? "#34332f" : "#dcd9d1";
      var wrap = document.createElement("div");
      wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-modal", "true"); wrap.setAttribute("aria-label", title);
      wrap.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.35);font:15px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif";
      var card = document.createElement("div");
      card.style.cssText = "max-width:380px;width:100%;background:" + bg + ";color:" + fg + ";border:1px solid " + edge + ";border-radius:14px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.25)";
      var h = document.createElement("div"); h.style.cssText = "font-weight:600;font-size:16px;margin-bottom:8px"; h.textContent = title;
      var b = document.createElement("div"); b.style.cssText = "color:" + mut + ";margin-bottom:14px;white-space:pre-line"; b.textContent = body;
      var row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
      buttons.forEach(function (x) {
        var btn = document.createElement("button"); btn.type = "button"; btn.textContent = x.label;
        btn.style.cssText = "min-height:40px;padding:0 16px;border-radius:10px;font:inherit;cursor:pointer;border:1px solid " + (x.primary ? "transparent" : edge) + ";background:" + (x.primary ? (dark ? "#f3f1ec" : "#171716") : "transparent") + ";color:" + (x.primary ? (dark ? "#171716" : "#ffffff") : fg);
        btn.onclick = function () { wrap.remove(); resolve(x.value); };
        row.appendChild(btn);
      });
      card.appendChild(h); card.appendChild(b); card.appendChild(row); wrap.appendChild(card); document.body.appendChild(wrap);
      var first = row.querySelector("button:last-child"); if (first) first.focus();
    });
  }
  function ask(names) {
    return loadMeta().then(function (m) {
      var title = (m && m.title ? m.title : "This page") + " wants to";
      var lines = names.map(function (n) { return "• " + (WORDS[n] || n); }).join("\n");
      return dialog(title, lines + "\n\nYou can say no: the page keeps working without it.", [{ label: "Not now", value: false }, { label: "Allow", value: true, primary: true }]);
    }).then(function (ok) {
      return post("permissions.grant", { names: names, allow: ok }).then(function (st) { if (meta) for (var k in st) meta.state[k] = st[k]; return ok; });
    });
  }
  function ensure(cap) {
    return loadMeta().then(function (m) {
      var s = m && m.state ? m.state[cap] : "unavailable";
      if (s === "granted") return true;
      if (s === "prompt") return ask([cap]);
      return false;
    });
  }
  function call(cap, op, args) {
    return post(cap + "." + op, args).catch(function (e) {
      if (e.code !== "consent_required") throw e;
      return ask([cap]).then(function (ok) { if (!ok) throw err("not_granted", cap + " was not allowed"); return post(cap + "." + op, args); });
    });
  }

  // ---- user -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  function userNs() {
    var info = null;
    function get() { return info ? Promise.resolve(info) : call("user", "info").then(function (i) { info = i; return i; }); }
    function me() { return get().then(function (i) { return { id: i.id, name: i.name, avatarUrl: "", color: "", email: null, isOwner: i.isOwner, canEdit: i.canEdit }; }); }
    return Object.freeze({
      isOwner: function () { return get().then(function (i) { return i.isOwner; }); },
      canEdit: function () { return get().then(function (i) { return i.canEdit; }); },
      can: function (c) { return get().then(function (i) { return c in i.can ? i.can[c] : null; }); },
      me: me,
      id: function () { return get().then(function (i) { return i.id; }); },
      name: function () { return get().then(function (i) { return i.name; }); },
      avatarUrl: function () { return Promise.resolve(null); },
      email: function () { return Promise.resolve(null); },
      search: function () { return Promise.resolve([]); },
      profiles: function (ids) { return get().then(function () { return call("user", "profiles", { ids: typeof ids === "string" ? [ids] : Array.prototype.slice.call(ids || []) }); }); }
    });
  }

  // ---- db -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  var SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  function checkPath(p, doc) {
    if (typeof p !== "string" || !p || p.length > 1000) throw new TypeError("a path is a non-empty string of at most 1000 bytes");
    var segs = p.split("/");
    if (segs.length > 16) throw new TypeError("a path has at most 16 segments");
    segs.forEach(function (s) { if (!SEG.test(s) || s === "." || s === "..") throw new TypeError("\"" + s + "\" is not a valid path segment"); });
    if (doc && segs.length % 2) throw new TypeError("a document path has an even number of segments (" + segs.length + " given)");
    if (!doc && segs.length % 2 === 0) throw new TypeError("a collection path has an odd number of segments (" + segs.length + " given)");
    return segs;
  }
  function freezeSnap(path, o) {
    var id = path.split("/").pop();
    var data = o.exists ? Object.freeze(o.data) : undefined;
    return Object.freeze({ id: id, exists: Boolean(o.exists), data: function () { return data; }, metadata: Object.freeze({ fromCache: false, hasPendingWrites: false }) });
  }
  function qsnap(docs, prev) {
    var snaps = docs.map(function (d) { return freezeSnap(d.path, { exists: true, data: d.data }); });
    var before = prev || [];
    var changes = [];
    var oldIdx = {}; before.forEach(function (d, i) { oldIdx[d.path] = i; });
    var newIdx = {}; docs.forEach(function (d, i) { newIdx[d.path] = i; });
    docs.forEach(function (d, i) {
      if (!(d.path in oldIdx)) changes.push({ type: "added", doc: snaps[i], oldIndex: -1, newIndex: i });
      else if (JSON.stringify(before[oldIdx[d.path]].data) !== JSON.stringify(d.data)) changes.push({ type: "modified", doc: snaps[i], oldIndex: oldIdx[d.path], newIndex: i });
    });
    before.forEach(function (d, i) { if (!(d.path in newIdx)) changes.push({ type: "removed", doc: freezeSnap(d.path, { exists: true, data: d.data }), oldIndex: i, newIndex: -1 }); });
    return Object.freeze({ docs: snaps, size: snaps.length, empty: snaps.length === 0, docChanges: function () { return changes; }, metadata: Object.freeze({ fromCache: false, hasPendingWrites: false }) });
  }
  function listen(kind, path, q, onData, onError) {
    var closed = false, es = null;
    ensure("db").then(function (ok) {
      if (closed) return;
      if (!ok) { onError && onError({ code: "not_granted", message: "db was not allowed" }); return; }
      var url = API + "/stream?kind=" + kind + "&path=" + encodeURIComponent(path) + (q ? "&q=" + encodeURIComponent(JSON.stringify(q)) : "");
      es = new EventSource(url, { withCredentials: true });
      es.addEventListener("snapshot", function (e) { if (!closed) { try { onData(JSON.parse(e.data)); } catch (x) { /* a bad frame is skipped */ } } });
      es.addEventListener("failure", function (e) { if (!closed) { closed = true; es.close(); try { var j = JSON.parse(e.data); onError && onError({ code: j.code || "unavailable", message: j.message || "" }); } catch (x) { onError && onError({ code: "unavailable", message: "" }); } } });
    });
    return function () { closed = true; if (es) es.close(); };
  }
  function newId() { var a = new Uint8Array(15); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return b.toString(36).padStart(2, "0"); }).join("").slice(0, 20); }
  function docRef(path) {
    checkPath(path, true);
    var ref = {
      id: path.split("/").pop(), path: path,
      get: function () { return call("db", "get", { path: path }).then(function (r) { return freezeSnap(path, r); }); },
      set: function (data) { return call("db", "set", { path: path, data: data }).then(function () {}); },
      update: function (data) { return call("db", "update", { path: path, data: data }).then(function () {}); },
      delete: function () { return call("db", "delete", { path: path }).then(function () {}); },
      acquire: function (o) { return call("db", "acquire", { path: path, holder: o && o.holder, ttlMs: o && o.ttlMs, data: o && o.data }); },
      onSnapshot: function (next, error) { return listen("doc", path, null, function (p) { next(freezeSnap(path, p)); }, error); },
      collection: function (p) { return collRef(path + "/" + p); }
    };
    return Object.freeze(ref);
  }
  function query(path, q) {
    var self = {
      where: function (f, op, v) { var n = { where: q.where.concat([{ field: f, op: op, value: v }]), orderBy: q.orderBy, limit: q.limit }; return query(path, n); },
      orderBy: function (f, dir) { return query(path, { where: q.where, orderBy: { field: f, dir: dir || "asc" }, limit: q.limit }); },
      limit: function (n) { return query(path, { where: q.where, orderBy: q.orderBy, limit: n }); },
      get: function () { return call("db", "query", { path: path, query: q }).then(function (r) { return qsnap(r.docs, null); }); },
      onSnapshot: function (next, error) { var prev = null; return listen("query", path, q, function (p) { var s = qsnap(p.docs, prev); prev = p.docs; next(s); }, error); }
    };
    return self;
  }
  function collRef(path) {
    checkPath(path, false);
    var base = query(path, { where: [], orderBy: null, limit: 1000 });
    return Object.freeze(Object.assign({}, base, {
      path: path,
      doc: function (id) { return docRef(path + "/" + (id || newId())); },
      add: function (data) { var r = docRef(path + "/" + newId()); return r.set(data).then(function () { return r; }); }
    }));
  }
  function dbNs() { return Object.freeze({ doc: docRef, collection: collRef }); }

  // ---- sample ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  function sampleNs() {
    function sample(input, o) {
      o = o || {};
      if (o.tools && o.tools.length) return Promise.reject(err("invalid_argument", "tools are not available in this runtime yet"));
      if (o.images) return Promise.reject(err("invalid_argument", "images are not available in this runtime yet"));
      return call("sample", "complete", { input: input }).then(function (r) { if (o.onText) { try { o.onText({ text: r.text, delta: r.text }); } catch (x) { /* the page's own */ } } return r; });
    }
    sample.json = function (input, o) { return sample(input, o).then(function (r) { var t = r.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); try { return JSON.parse(t); } catch (e) { throw err("invalid_argument", "the answer was not JSON"); } }); };
    sample.limits = function () { return call("sample", "limits"); };
    return Object.freeze(sample);
  }

  // ---- downloads --------------------------------------------------------------------------------------------------------------------------------------------------------------
  function downloadsNs() {
    return Object.freeze({
      save: function (req) {
        return call("downloads", "check").then(function () {
          if (!req || typeof req.filename !== "string" || !req.filename || /[\\/]/.test(req.filename)) throw err("bad_request", "a download needs a plain file name");
          return dialog("Save " + req.filename + "?", "This page made a file for you.", [{ label: "Not now", value: false }, { label: "Save", value: true, primary: true }]);
        }).then(function (ok) {
          if (!ok) throw err("declined", "the viewer did not save it");
          var blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
          var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = req.filename; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
          return { status: "saved" };
        });
      }
    });
  }

  // ---- permissions (built in) ------------------------------------------------------------------------------------------------------------------------------------------
  function permissionsNs() {
    return Object.freeze({
      state: function (name) { return loadMeta().then(function (m) { var s = (m && m.state) || { permissions: "granted" }; return name === undefined ? Object.assign({}, s) : (name in s ? s[name] : "unavailable"); }); },
      request: function (names) {
        return loadMeta().then(function (m) {
          var st = (m && m.state) || {};
          var want = (names || Object.keys(st)).filter(function (n) { return st[n] === "prompt"; });
          return (want.length ? ask(want) : Promise.resolve(true)).then(function () { return Object.assign({}, meta && meta.state); });
        });
      },
      manage: function () {
        return loadMeta().then(function (m) {
          var st = (m && m.state) || {};
          var names = Object.keys(st).filter(function (n) { return n !== "permissions" && st[n] !== "unavailable"; });
          if (!names.length) return dialog("Permissions", "This page has not asked for anything.", [{ label: "Done", value: true, primary: true }]).then(function () {});
          return dialog("Permissions", names.map(function (n) { return "• " + (WORDS[n] || n) + ": " + st[n]; }).join("\n"), [{ label: "Close", value: 0 }, { label: "Allow all", value: 1, primary: true }, { label: "Turn all off", value: 2 }]).then(function (v) {
            if (v === 0) return;
            return post("permissions.grant", { names: names, allow: v === 1 }).then(function (s2) { if (meta) for (var k in s2) meta.state[k] = s2[k]; });
          });
        });
      }
    });
  }

  var memo = {};
  var make = { db: dbNs, user: userNs, sample: sampleNs, downloads: downloadsNs, permissions: permissionsNs };
  window[NAME] = Object.freeze({
    use: function (name) {
      name = String(name);
      if (memo[name]) return memo[name];
      if (!make[name]) return Promise.resolve(null);
      var p = loadMeta().then(function (m) {
        if (name === "permissions") return make.permissions();
        if (!m || m.declared.indexOf(name) < 0 || m.state[name] === "denied") return null;
        return make[name]();
      });
      memo[name] = p;
      return p;
    }
  });
})();
