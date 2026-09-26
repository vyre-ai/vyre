// @ts-check
// teach — what other modules tell Memory, through ctx.memory.teach(kind, fact).
//
// A module never writes Memory's tables. It hands the curator a fact; the curator folds it into
// the graph on its next pass, with provenance {module, kind} where a fact from a transcript has
// (session, seq). So memory.why can always say where a fact came from, whichever way it arrived.
//
// A fact is graph-shaped, so it lands on the same nodes the transcripts produce:
//
//   { subject: "Dana Reyes" | { name, email?, domain?, repo?, kind? },
//     rel?: "works_at" | "has_email" | "has_domain" | "owned_by" | <snake_case>,
//     object?: same shape as subject,
//     text?: "one readable line", at?: <ms when it became true>, key?: "<the module's id>",
//     forget?: true }
//
// A subject with both a name and an email also says that person has that address. Teaching the
// same fact again changes nothing; teaching under the same key replaces it; forget removes it.

import { createHash } from "node:crypto";
import { registrable } from "./lexicon.js";

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REL = /^[a-z][a-z_]{1,40}$/;
/** What each known relation says about the kinds at its two ends. */
const ENDS = { works_at: ["person", "org"], has_email: ["person", "email"], has_domain: ["org", "domain"], owned_by: ["repo", "org"] };

/** @typedef {{ id: string, kind: string|null }} Ref */
/** @typedef {{ src: Ref, rel: string|null, dst: Ref|null }} Claim */

/**
 * A reference to a thing, as the node id the extractor would give it.
 * @returns {Ref}
 */
export function ref(x, where = "subject") {
  if (typeof x === "string") x = { name: x };
  if (!x || typeof x !== "object") throw new Error(`${where} must be a name or { name, email, domain, repo }`);
  const hint = ["person", "org"].includes(x.kind) ? x.kind : null;
  if (x.repo) { if (!REPO.test(String(x.repo))) throw new Error(`${where}.repo must look like owner/name`); return { id: "repo:" + x.repo, kind: "repo" }; }
  const name = typeof x.name === "string" ? x.name.replace(/\s+/g, " ").trim() : "";
  if (name && EMAIL.test(name)) return { id: "email:" + name.toLowerCase(), kind: "email" };
  if (name && REPO.test(name) && !name.includes(" ")) return { id: "repo:" + name, kind: "repo" };
  if (name && DOMAIN.test(name)) return { id: "domain:" + registrable(name), kind: "domain" };
  if (name) {
    if (name.length > 120) throw new Error(`${where}.name is too long`);
    return { id: "name:" + name, kind: hint };
  }
  if (x.email) { if (!EMAIL.test(String(x.email))) throw new Error(`${where}.email is not an address`); return { id: "email:" + String(x.email).toLowerCase(), kind: "email" }; }
  if (x.domain) { if (!DOMAIN.test(String(x.domain))) throw new Error(`${where}.domain is not a domain`); return { id: "domain:" + registrable(String(x.domain)), kind: "domain" }; }
  throw new Error(`${where} needs a name, email, domain or repo`);
}

/**
 * Check a taught fact and turn it into claims about nodes. Throws with a readable reason.
 * @returns {{ key: string, text: string|null, at: number, forget: boolean, claims: Claim[], stored: string }}
 */
export function lesson(fact) {
  if (!fact || typeof fact !== "object" || Array.isArray(fact)) throw new Error("fact must be an object");
  const key = fact.key == null ? null : String(fact.key);
  if (key !== null && (!key || key.length > 200)) throw new Error("fact.key must be a short string");
  // Stored in a fixed key order, so the same fact taught twice is byte-for-byte the same row.
  const clean = {
    subject: fact.subject, rel: fact.rel ?? null, object: fact.object ?? null,
    text: fact.text == null ? null : String(fact.text).slice(0, 400), at: Number.isFinite(fact.at) ? Math.trunc(fact.at) : 0,
  };
  const stored = JSON.stringify(clean);
  const k = key ?? createHash("sha256").update(stored).digest("hex").slice(0, 24);
  if (fact.forget) return { key: k, text: null, at: 0, forget: true, claims: [], stored };
  const src = ref(clean.subject, "subject");
  const claims = [];
  if (clean.rel !== null) {
    if (!REL.test(String(clean.rel))) throw new Error("rel must be snake_case, like works_at");
    const dst = ref(clean.object, "object");
    const ends = ENDS[/** @type {keyof typeof ENDS} */ (clean.rel)];
    claims.push({ src: { ...src, kind: src.kind || (ends ? ends[0] : null) }, rel: String(clean.rel), dst: { ...dst, kind: dst.kind || (ends ? ends[1] : null) } });
  } else {
    if (clean.object != null) throw new Error("an object needs a rel");
    claims.push({ src, rel: null, dst: null });
  }
  // { name, email } names a person and their address in one go.
  const s = typeof clean.subject === "object" ? clean.subject : null;
  if (s && s.name && s.email && src.id.startsWith("name:")) {
    claims.push({ src: { ...src, kind: src.kind || "person" }, rel: "has_email", dst: ref({ email: s.email }, "subject.email") });
  }
  return { key: k, text: clean.text, at: clean.at, forget: false, claims, stored };
}
