// @ts-check
// tools/cli: the vault tools behind `vyre vault` beyond put and run: item metadata, reference
// resolution and file rendering, editing in place, the git credential helper and the SSH agent.
//
// They use only the Vault's public methods (row, fields, put, list, match, audit, remove), so
// the key hierarchy under them can change without touching this file. Two small tables of our
// own hold what must be readable while the vault is locked: an ssh-key item's public half, and
// the "stale" mark git leaves on a login whose password it saw fail. They are created with IF
// NOT EXISTS, outside the numbered migrations, so this file never races another change to the
// vault's migration list.
//
// Every tool that hands out or writes a value declares presence (ADR 0004, ADR 0006 section 3)
// with a summary naming the items and the destination, never the value. `vault.render` writes
// the file itself so the values never cross vyred's socket. The SSH agent keeps private keys in
// vyred and asks a person before the first signature per key and host.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { totp } from "../totp.js";
import { parseRef, parseTemplate } from "../refs.js";
import { parseRequest, requestOrigin, candidates, formatResponse } from "../git.js";
import { parsePrivate, generateKey, TYPES as SSH_TYPES } from "../ssh/keys.js";
import { SshAgent, listen, LEASE_MS } from "../ssh/agent.js";
import { gitSync } from "../../../lib/git-safe.js";
import { defaultField } from "../../../lib/vault-kinds/kinds.js";

const PEOPLE = ["cli", "local"];
const str = { type: "string" };
const strs = { type: "array", items: { type: "string" } };
const obj = (properties, required = []) => ({ type: "object", properties, required });

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HISTORY_KEEP = 10;

export const CLI_TOOLS = ["vault.item", "vault.resolve", "vault.render", "vault.edit", "vault.git",
  "vault.ssh.keys", "vault.ssh.generate", "vault.ssh.add", "vault.ssh.approvals", "vault.ssh.approve", "vault.ssh.forget"];

const quoteList = names => names.map(n => `"${n}"`).join(", ");
const namesOf = refs => [...new Set(refs.map(r => { try { return parseRef(r).name; } catch { return String(r).slice(0, 40); } }))];

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault }} deps
 * @returns {Promise<{ list(listing: any, input: any): any, stop(): Promise<void>, ssh: { agent: SshAgent, socket: string|null, setApprover(fn: any): void } }>}
 */
export async function register({ ctx, vault }) {
  const db = ctx.store.db;
  // vault_ssh_keys and vault_marks are numbered migrations in vault.js now, with a mac column.
  const emit = (t, p) => ctx.events.emit(t, p);

  /** Open an item's fields; a locked vault says which one in words the CLI maps to exit 4. */
  const open = r => vault.fields(r);
  const mustRow = name => { const r = vault.row(name); if (!r) throw new Error(`no item named ${name}`); return r; };
  const listed = name => vault.list({}).items.find(i => i.name === name);

  // ---- metadata: listing extras --------------------------------------------------------

  // Both tables are MACed (vault.js MACED): a row a module wrote is ignored and audited.
  const sshInfo = name => { const r = /** @type {any} */ (db.prepare("SELECT * FROM vault_ssh_keys WHERE name = ?").get(name)); return r && vault.rowOk("vault_ssh_keys", r) ? r : undefined; };
  const staleOf = name => { const m = /** @type {any} */ (db.prepare("SELECT * FROM vault_marks WHERE name = ?").get(name)); return m && m.stale && vault.rowOk("vault_marks", m) ? String(m.stale) : null; };
  const setStale = (name, why) => { db.prepare("INSERT OR REPLACE INTO vault_marks (name, stale, at) VALUES (?,?,?)").run(name, why, Date.now()); vault.sign("vault_marks", name); };
  const clearStale = name => db.prepare("DELETE FROM vault_marks WHERE name = ?").run(name);
  const rememberSsh = (name, k) => { db.prepare("INSERT OR REPLACE INTO vault_ssh_keys (name, type, fingerprint, public, at) VALUES (?,?,?,?,?)").run(name, k.type, k.fingerprint, k.public, Date.now()); vault.sign("vault_ssh_keys", name); };

  /** Add ssh and stale to listed items, and apply the kind and host filters. */
  const decorate = it => {
    const out = { ...it };
    if (it.kind === "ssh-key") { const s = sshInfo(it.name); if (s) out.ssh = { type: s.type, fingerprint: s.fingerprint, public: s.public }; }
    const st = staleOf(it.name);
    if (st) { out.stale = true; out.staleWhy = st; }
    return out;
  };
  const list = (listing, input = {}) => {
    const host = input.host ? String(input.host).toLowerCase() : "";
    const items = (listing.items || [])
      .filter(i => !input.kind || i.kind === input.kind)
      .filter(i => !host || (i.hosts || []).some(h => h.toLowerCase().includes(host)) || String(i.url || "").toLowerCase().includes(host))
      .map(decorate);
    return { ...listing, items };
  };

  // ---- values: references --------------------------------------------------------------

  /** One field's value from opened fields; `otp` is the current code when there is no otp field. */
  const pick = (r, f, field) => {
    if (r.kind === "ssh-key" && (field || "private") === "private") throw new Error(`${r.name} is an ssh key; its private half never leaves vyred · use the ssh agent`);
    if (r.kind === "passkey" && (field || "private_key") === "private_key") throw new Error(`${r.name} is a passkey; its private key never leaves vyred`);
    if (field === "otp" && !("otp" in f)) {
      if (!f.totp) throw new Error(`${r.name} has no one-time password`);
      return totp(f.totp).code;
    }
    const want = field || defaultField(r.kind, Object.keys(f));
    if (!want) throw new Error(`${r.name} is ${r.kind === "env-set" ? "an env-set" : `a ${r.kind}`}; name the field: vault://${r.name}/<FIELD>`);
    if (!(want in f)) throw new Error(`${r.name} has no field ${want}`);
    return f[want];
  };

  /** Values for refs, each item opened once and audited once. Missing items fail the whole call. */
  const resolveRefs = async (refs, caller, action, dest) => {
    const parsed = refs.map(parseRef);
    const byName = new Map();
    for (const p of parsed) {
      if (byName.has(p.name)) continue;
      const r = vault.row(p.name);
      if (!r) { vault.audit(action, p.name, caller, false, "no such item"); throw new Error(`no item named ${p.name}`); }
      byName.set(p.name, { r, f: await open(r) });
    }
    /** @type {Record<string, string>} */
    const values = {};
    try { for (const p of parsed) { const { r, f } = byName.get(p.name); values[p.ref] = pick(r, f, p.field); } }
    catch (e) { for (const n of byName.keys()) vault.audit(action, n, caller, false, /** @type {Error} */ (e).message.replace(/ ·.*$/, "")); throw e; }
    for (const n of byName.keys()) { vault.audit(action, n, caller, true, dest ? `to ${dest}` : null); emit("vault.released", { name: n, module: action }); }
    return values;
  };

  ctx.tool("vault.item", {
    description: "One item's metadata: kind, description, field names, url, hosts, grants, ssh public key. Never a value.",
    input: obj({ name: str }, ["name"]),
    run: ({ name }) => {
      const it = listed(name);
      if (!it) throw new Error(`no item named ${name}`);
      return { item: { ...decorate(it), otp: (it.fields || []).includes("totp") } };
    },
  });

  ctx.tool("vault.resolve", {
    description: "Values for vault://item/field references, for `vyre vault read` and `inject` to stdout. People only, with presence.",
    input: obj({ refs: strs, destination: str }, ["refs"]), callers: PEOPLE,
    presence: { summary: async ({ refs = [], destination }) => `Reveal ${quoteList(namesOf(refs))} (${refs.length} ${refs.length === 1 ? "reference" : "references"}) to ${destination || "the terminal"}` },
    run: async ({ refs, destination }, { caller }) => {
      if (!refs.length) throw new Error("name at least one vault://item/field reference");
      if (refs.length > 200) throw new Error("at most 200 references at once");
      return { values: await resolveRefs(refs, caller, "resolve", destination || "stdout") };
    },
  });

  /** Is this path tracked by git, or in a work tree without being ignored? Words for a warning. */
  const gitWarnings = file => {
    const dir = path.dirname(file), base = path.basename(file);
    const git = args => gitSync(dir, args, { timeout: 5000 }).ok;
    if (!git(["rev-parse", "--is-inside-work-tree"])) return [];
    if (git(["ls-files", "--error-unmatch", "--", base])) return [`${file} is tracked by git: the values will be committed with it · git rm --cached it and add it to .gitignore`];
    if (!git(["check-ignore", "-q", "--", base])) return [`${file} is inside a git work tree and not ignored · add it to .gitignore`];
    return [];
  };

  ctx.tool("vault.render", {
    description: "Render a template's {{ vault://item/field }} references into a file vyred writes itself (0600), so values never cross the socket.",
    input: obj({ template: str, out: str, force: { type: "boolean" } }, ["template", "out"]), callers: PEOPLE,
    presence: { summary: async ({ template, out }) => {
      let names = [];
      try { names = namesOf(parseTemplate(template).filter(p => "ref" in p).map(p => /** @type {any} */ (p).ref)); } catch {}
      return `Write ${quoteList(names) || "nothing"} into ${out}`;
    } },
    run: async ({ template, out, force }, { caller }) => {
      if (!path.isAbsolute(out)) throw new Error("out must be an absolute path");
      const file = path.resolve(out);
      const parts = parseTemplate(template);
      const refs = [...new Set(parts.filter(p => "ref" in p).map(p => /** @type {any} */ (p).ref))];
      let exists = false;
      try { fs.lstatSync(file); exists = true; } catch {}
      if (exists && !force) throw new Error(`${file} already exists · --force replaces it`);
      if (!fs.existsSync(path.dirname(file))) throw new Error(`${path.dirname(file)} does not exist`);
      const values = refs.length ? await resolveRefs(refs, caller, "render", path.basename(file)) : {};
      const text = parts.map(p => ("ref" in p ? values[p.ref] : p.text)).join("");
      // A fresh temp file beside the target (wx: never an existing one), synced, then renamed
      // over it, so a reader sees the old file or the whole new one, never half of it.
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.vyre-${crypto.randomBytes(6).toString("hex")}.tmp`);
      const fd = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
      return { file, refs: refs.length, items: namesOf(refs), replaced: exists, warnings: gitWarnings(file) };
    },
  });

  // ---- edit ----------------------------------------------------------------------------

  ctx.tool("vault.edit", {
    description: "Change an item in place: merge fields, remove fields, rename, description, url, add or remove hosts. People only, with presence.",
    input: obj({ name: str, rename: str, description: str, url: str, fields: { type: "object" }, removeFields: strs, addHosts: strs, removeHosts: strs }, ["name"]),
    callers: PEOPLE,
    presence: { summary: async i => {
      const what = [i.fields && `replace ${Object.keys(i.fields).join(", ")}`, i.removeFields?.length && `remove ${i.removeFields.join(", ")}`,
        i.rename && `rename to "${i.rename}"`, i.description !== undefined && "change the description", i.url !== undefined && "change the url",
        (i.addHosts?.length || i.removeHosts?.length) && "change the hosts"].filter(Boolean);
      return `Edit "${i.name}": ${what.join(", ") || "no change"}`;
    } },
    run: async (i, { caller }) => {
      const r = mustRow(i.name);
      const it = listed(i.name);
      if (i.rename !== undefined) {
        if (!NAME.test(i.rename)) throw new Error("a name is letters, digits, dot, dash and underscore, up to 128");
        if (i.rename !== i.name && vault.row(i.rename)) throw new Error(`${i.rename} already exists`);
      }
      if (i.fields && Object.values(i.fields).some(v => typeof v !== "string")) throw new Error("field values must be text");
      const f = await open(r);
      const fields = { ...f, ...(i.fields || {}) };
      for (const k of i.removeFields || []) delete fields[k];
      const add = (i.addHosts || []).map(h => { try { return new URL(h).origin; } catch { throw new Error(`host ${h} is not an origin such as https://api.example.com`); } });
      const drop = new Set((i.removeHosts || []).map(h => { try { return new URL(h).origin; } catch { return h; } }));
      const hosts = [...new Set([...(it.hosts || []), ...add])].filter(h => !drop.has(h));
      const target = i.rename && i.rename !== i.name ? i.rename : i.name;
      const input = { name: target, kind: r.kind, description: i.description !== undefined ? i.description : r.description, fields,
        url: i.url !== undefined ? (i.url || null) : r.url, hosts, origin: r.origin || undefined };
      if (target === i.name) {
        await vault.put(input, caller);
        if (i.fields && "password" in i.fields) clearStale(i.name);
        return { name: target, kind: r.kind, fields: Object.keys(fields) };
      }
      // A rename is a new item and the old one removed, grants carried over. remove() refuses an
      // item in a live pass, and then the new copy goes too, so nothing is left half done.
      await vault.put(input, caller);
      try { vault.remove({ name: i.name }, caller); }
      catch (e) { vault.remove({ name: target }, caller); throw e; }
      for (const g of it.grants || []) await vault.grant({ name: target, module: g.module, watcher: g.watcher || "" }, caller);
      const ssh = sshInfo(i.name), mark = staleOf(i.name);
      db.prepare("UPDATE vault_ssh_keys SET name = ? WHERE name = ?").run(target, i.name);
      db.prepare("UPDATE vault_marks SET name = ? WHERE name = ?").run(target, i.name);
      if (ssh) vault.sign("vault_ssh_keys", target);
      if (mark) vault.sign("vault_marks", target);
      return { name: target, kind: r.kind, fields: Object.keys(fields), renamedFrom: i.name };
    },
  });

  // ---- git credential helper -----------------------------------------------------------

  /** Logins that fit the request, narrowed by username when git gave one. Opens only candidates. */
  const gitMatches = async (req, { skipStale = false } = {}) => {
    const logins = vault.list({}).items.filter(i => i.kind === "login" && !(skipStale && staleOf(i.name)));
    const found = [];
    for (const l of candidates(logins, req)) {
      const r = vault.row(l.name);
      if (!r) continue;
      found.push({ name: l.name, r, f: await open(r) });
    }
    if (!req.username) return found;
    const same = found.filter(m => m.f.username === req.username);
    return same.length ? same : found.filter(m => !m.f.username);
  };

  const gitWhere = req => (requestOrigin(req) || `${req.protocol || "?"}://${req.host || "?"}`) + (req.path ? "/" + String(req.path).replace(/^\/+/, "") : "");

  ctx.tool("vault.git", {
    description: "The git credential helper (git-credential-vyre): get, store or erase, for logins matched by exact origin.",
    input: obj({ action: { type: "string", enum: ["get", "store", "erase"] }, request: str }, ["action", "request"]),
    callers: PEOPLE,
    // git prints what it gets, so every get needs a person; erase only takes away.
    presence: {
      summary: async ({ action, request }) => {
        const req = parseRequest(request);
        return action === "get" ? `Give git the login for ${gitWhere(req)}` : action === "store" ? `Save git's login for ${gitWhere(req)}` : `Mark git's login for ${gitWhere(req)} as failed`;
      },
      skip: ({ input }) => input && input.action === "erase",
    },
    run: async ({ action, request }, { caller }) => {
      const req = parseRequest(request);
      const where = gitWhere(req);
      if (!requestOrigin(req)) return { action, response: "", why: `git asked for ${where}; only http and https logins are matched` };
      if (action === "get") {
        const m = await gitMatches(req, { skipStale: true });
        if (m.length !== 1) {
          vault.audit("git-get", null, caller, false, m.length ? `ambiguous for ${where}` : `no login for ${where}`);
          return { action, response: "", why: m.length ? `${m.length} logins match ${where} (${m.map(x => x.name).join(", ")}); give git a username to choose` : `no login for ${where}` };
        }
        const { name, f } = m[0];
        if (!f.password) return { action, response: "", why: `${name} has no password` };
        vault.audit("git-get", name, caller, true, `for ${where}`);
        emit("vault.released", { name, module: "git" });
        return { action, name, response: formatResponse({ username: f.username || req.username, password: f.password }) };
      }
      if (action === "store") {
        if (!req.username || !req.password) return { action, response: "", why: "git sent no username and password to store" };
        const m = await gitMatches(req);
        if (m.length > 1) return { action, response: "", why: `${m.length} logins match ${where}; not choosing one` };
        if (!m.length) {
          const host = String(req.host).replace(/[^A-Za-z0-9._-]/g, "-");
          let name = host;
          for (let n = 2; vault.row(name); n++) name = `${host}-${n}`;
          const url = requestOrigin(req) + (req.path ? "/" + String(req.path).replace(/^\/+/, "") : "");
          await vault.put({ name, kind: "login", description: "saved by git", fields: { username: req.username, password: req.password }, url }, caller);
          vault.audit("git-store", name, caller, true, `new login for ${where}`);
          return { action, name, stored: true, created: true, response: "" };
        }
        const { name, r, f } = m[0];
        clearStale(name);
        if (f.password === req.password && f.username === req.username) return { action, name, stored: false, same: true, response: "" };
        let history = [];
        try { history = f.history ? JSON.parse(f.history) : []; } catch { history = []; }
        if (f.password) history.push({ password: f.password, until: Date.now() });
        const it = listed(name);
        await vault.put({ name, kind: "login", description: r.description, url: r.url, hosts: it.hosts || [], origin: r.origin || undefined,
          fields: { ...f, username: req.username, password: req.password, history: JSON.stringify(history.slice(-HISTORY_KEEP)) } }, caller);
        vault.audit("git-store", name, caller, true, `password replaced for ${where}; the old one kept in history`);
        return { action, name, stored: true, created: false, response: "" };
      }
      // erase: git saw this login fail. Mark it, never delete it: the person decides.
      const m = await gitMatches(req);
      const marked = m.filter(x => !req.password || x.f.password === req.password).map(x => x.name);
      for (const n of marked) {
        setStale(n, `git reported a failed login for ${where}`);
        vault.audit("git-erase", n, caller, true, "marked stale");
        emit("vault.item-changed", { name: n, kind: "login", stale: true });
      }
      return { action, marked, response: "" };
    },
  });

  // ---- SSH agent -----------------------------------------------------------------------

  const sshCfg = (ctx.config && ctx.config.vault && ctx.config.vault.ssh) || null;
  let socket = null;
  if (sshCfg) {
    const rel = typeof sshCfg === "object" && sshCfg.socket ? String(sshCfg.socket) : path.join("ssh", "agent.sock");
    const root = path.resolve(ctx.paths.root);
    socket = path.resolve(root, rel);
    if (!socket.startsWith(root + path.sep)) throw new Error("vault.ssh.socket must be under the Vyre home");
  }

  /** Public info for every ssh-key item, filling in what a plain vault.put left out (needs unlock). */
  const sshKeys = async () => {
    const out = [];
    for (const it of vault.list({}).items.filter(i => i.kind === "ssh-key")) {
      let s = sshInfo(it.name);
      // Missing, or older than the item (put again without this file knowing): read it afresh.
      if (!s || s.at < it.updated) {
        try { const k = parsePrivate((await open(mustRow(it.name))).private); rememberSsh(it.name, k); s = sshInfo(it.name); }
        catch { out.push({ name: it.name, type: null, fingerprint: null, public: null, problem: "not readable as an OpenSSH key, or the vault is locked" }); continue; }
      }
      out.push({ name: it.name, type: s.type, fingerprint: s.fingerprint, public: s.public });
    }
    return out;
  };

  let approver = async req => {
    ctx.log(`ssh: approval needed to ${req.summary} · vyre vault ssh approvals, then vyre vault ssh approve ${req.id}`);
    return false;
  };
  const agent = new SshAgent({
    identities: async () => (await sshKeys()).filter(k => k.public).map(k => ({ name: k.name, blob: Buffer.from(String(k.public).split(" ")[1], "base64"), comment: k.name })),
    privateKey: async name => {
      const r = mustRow(name);
      if (r.kind !== "ssh-key") throw new Error(`${name} is not an ssh key`);
      return parsePrivate((await open(r)).private);
    },
    approve: req => approver(req),
    audit: (ok, name, host, why) => vault.audit("ssh-sign", name, `ssh:${host}`, ok, why),
    onApproved: l => emit("vault.ssh-approved", { name: l.name, host: l.host, expires: l.expires }),
    isLocked: () => vault.locked(),
  });
  // Leases end when the vault locks, whoever locks it.
  try { ctx.events.on("vault.locked", () => agent.clear()); } catch {}
  const listener = socket ? await listen(socket, agent) : null;
  if (listener) ctx.log(`vault ssh agent listening on ${listener.path}`);

  ctx.tool("vault.ssh.keys", {
    description: "SSH keys in the vault: name, type, fingerprint and public key, plus the agent socket. Never a private key.",
    input: obj({}),
    run: async () => ({ socket, keys: await sshKeys() }),
  });

  /** Store an ssh key item and its public half. */
  const storeKey = async (name, text, caller, how) => {
    const k = parsePrivate(text);
    await vault.put({ name, kind: "ssh-key", description: `${k.type} ssh key${k.comment ? " · " + k.comment : ""}`, fields: { private: text } }, caller);
    rememberSsh(name, k);
    vault.audit(how, name, caller, true, k.fingerprint);
    return { name, type: k.type, fingerprint: k.fingerprint, public: k.public };
  };

  ctx.tool("vault.ssh.generate", {
    description: "Generate an SSH key in vyred and store it; returns only the public key and fingerprint. A new name only.",
    input: obj({ name: str, type: { type: "string", enum: SSH_TYPES }, comment: str }, ["name"]),
    callers: ["cli", "local", "mcp"],
    run: async ({ name, type = "ed25519", comment }, { caller }) => {
      if (!NAME.test(String(name))) throw new Error("a name is letters, digits, dot, dash and underscore, up to 128");
      if (vault.row(name)) throw new Error(`${name} already exists; generate into a new name`);
      return { key: await storeKey(name, generateKey(type, comment || name), caller, "ssh-generate") };
    },
  });

  ctx.tool("vault.ssh.add", {
    description: "Add an existing OpenSSH private key file. vyred reads the file itself; the key never crosses the socket.",
    input: obj({ name: str, file: str }, ["name", "file"]), callers: PEOPLE,
    presence: { summary: async ({ name, file }) => `Add the ssh key in ${file} to the vault as "${name}"` },
    run: async ({ name, file }, { caller }) => {
      if (!NAME.test(String(name))) throw new Error("a name is letters, digits, dot, dash and underscore, up to 128");
      if (vault.row(name)) throw new Error(`${name} already exists`);
      const p = path.resolve(file);
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 64 * 1024) throw new Error(`${p} is not a key file`);
      return { key: await storeKey(name, fs.readFileSync(p, "utf8"), caller, "ssh-add"), advice: `The key is in the vault now; delete ${p} when nothing else needs it.` };
    },
  });

  ctx.tool("vault.ssh.approvals", {
    description: "SSH signing leases (key, destination host, until) and requests waiting for a person.",
    input: obj({}), callers: PEOPLE,
    run: () => ({ ...agent.approvals(), leaseHours: LEASE_MS / 3600_000 }),
  });

  ctx.tool("vault.ssh.approve", {
    description: "Approve a waiting SSH signing request: its key may sign for that host for 8 hours or until the vault locks.",
    input: obj({ id: str }, ["id"]), callers: PEOPLE,
    presence: { summary: async ({ id }) => { const w = agent.waiting.find(x => x.id === id); return w ? `Let ssh key "${w.name}" ${w.summary.replace(/ with ssh key .*$/, "")} for 8 hours` : `Approve ssh request ${id}`; } },
    run: ({ id }, { caller }) => {
      const w = agent.waiting.find(x => x.id === id);
      if (!w) throw new Error(`no ssh request ${id} is waiting · vyre vault ssh approvals`);
      const l = agent.grant(w);
      vault.audit("ssh-approve", w.name, caller, true, `for ${w.host}`);
      emit("vault.ssh-approved", { name: l.name, host: l.host, expires: l.expires });
      return { lease: l };
    },
  });

  ctx.tool("vault.ssh.forget", {
    description: "End SSH signing leases: all of them, or those for one key or host. The next signature asks again.",
    input: obj({ name: str, host: str }),
    run: ({ name, host }, { caller }) => {
      const n = agent.forget({ ...(name ? { name } : {}), ...(host ? { host } : {}) });
      vault.audit("ssh-forget", name || null, caller, true, `${n} ended`);
      return { ended: n };
    },
  });

  return {
    list,
    ssh: { agent, socket, setApprover: fn => { approver = fn; } },
    async stop() { agent.clear(); if (listener) await listener.close(); },
  };
}
