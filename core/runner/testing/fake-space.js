// A fake space for tests: the vault (lease, use) and the sync port (transcript, files, checkpoints), all in memory.
// It is the shape the real space client must have; the vault and sessions teams implement the real one.

import crypto from "node:crypto";

export function fakeSpace(o = {}) {
  const st = {
    revoked: false, offline: false, leases: 0, renews: 0, uses: [],
    transcript: new Map(), files: new Map(), checkpoints: new Map(),
    key: o.key || crypto.randomBytes(32),
    secrets: o.secrets || { "vault://provider": "sk-REAL-PROVIDER-SECRET-0001", "vault://gmail": "ya29.REAL-GMAIL-SECRET" },
    ttlMs: o.ttlMs || 3_600_000,
  };
  const guard = () => { if (st.offline) throw new Error("offline"); };
  const vault = {
    async lease() { guard(); if (st.revoked) return { revoked: true }; st.leases++; return { id: "lease-" + st.leases, key: st.key.toString("base64"), ttlMs: st.ttlMs }; },
    async renew() { guard(); st.renews++; if (st.revoked) return { revoked: true }; return { ttlMs: st.ttlMs }; },
    async use({ ref, session, route }) { guard(); if (st.revoked) throw new Error("revoked"); st.uses.push({ ref, session, route }); const v = st.secrets[ref]; if (!v) throw new Error("no such credential"); return v; },
  };
  const sync = {
    async appendTranscript(s, entries) { guard(); const t = st.transcript.get(s) || []; for (const e of entries) if (!t.some(x => x.seq === e.seq)) t.push(e); st.transcript.set(s, t); return { acked: t.length ? Math.max(...t.map(x => x.seq)) : 0 }; },
    async getTranscript(s, from) { guard(); return (st.transcript.get(s) || []).filter(e => e.seq >= from); },
    async putFile(s, rel, bytes, { base } = {}) { guard(); const k = s + "|" + rel; const v = st.files.get(k) || []; v.push(bytes === null ? null : Buffer.from(bytes)); st.files.set(k, v); return { version: v.length }; },
    async getFile(s, rel, version) { guard(); const v = (st.files.get(s + "|" + rel) || [])[version - 1]; if (!v) throw new Error("no such version"); return v; },
    async putCheckpoint(s, cp) { guard(); st.checkpoints.set(s, JSON.parse(JSON.stringify(cp))); return { ok: true }; },
    async getCheckpoint(s) { guard(); return st.checkpoints.get(s) || null; },
  };
  return { vault, sync, state: st };
}
