// @ts-check
// One writer per file, across sessions and agents, held as a file under the home so two processes share it.
// The second writer waits up to 10 seconds. After that the call is refused and names who holds the file. The first writer's bytes stay.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** How long a second writer waits for the file. */
export const WAIT_MS = 10_000;
/** A lock older than this is a crashed holder: it is dropped and the waiter tries again. */
const STALE_MS = 120_000;
const POLL_MS = 50;

/** @param {string} key the Drive path, or the agent-folder path */
export function lockName(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 32) + ".lock";
}

/** @param {string} dir @param {string} key */
export function lockPath(dir, key) {
  return path.join(dir, lockName(key));
}

/**
 * Who is named when the wait runs out: the agent on the call, else the person.
 * A second session of the same person waits too. The name is a label, not a secret.
 * @param {any} chain @param {any} meta
 */
export function holderOf(chain, meta) {
  if (meta && typeof meta.agent === "string" && meta.agent) return `agent:${meta.agent}`;
  const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
  const agent = hops.find((/** @type {any} */ h) => h && h.actor && h.actor.kind === "agent" && h.actor.id);
  if (agent) return `agent:${agent.actor.id}`;
  const person = hops.find((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person" && h.actor.id);
  return person ? `person:${person.actor.id}` : "someone";
}

/**
 * @param {string} dir
 * @returns {{ hold: <T>(key: string, who: string, fn: () => Promise<T>) => Promise<T>, dir: string }}
 */
export function createWriteLock(dir) {
  return {
    dir,
    /** Take the file, run `fn`, then let it go. A waiter polls until the deadline. */
    async hold(key, who, fn) {
      fs.mkdirSync(dir, { recursive: true });
      const file = lockPath(dir, key);
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        let fd;
        try { fd = fs.openSync(file, "wx"); }
        catch (e) {
          if (!e || /** @type {any} */ (e).code !== "EEXIST") throw e;
          let holder = "someone";
          try {
            const raw = JSON.parse(fs.readFileSync(file, "utf8"));
            if (raw && typeof raw.who === "string" && raw.who) holder = raw.who;
            if (raw && typeof raw.at === "number" && Date.now() - raw.at > STALE_MS) {
              try { fs.unlinkSync(file); } catch { /* the holder, or another waiter, already removed it */ }
              continue;
            }
          } catch { /* unreadable: keep waiting, then say someone holds it */ }
          if (Date.now() >= deadline) throw Object.assign(new Error(`${holder} has this file open for writing`), { code: "locked", detail: { holder } });
          await new Promise((r) => setTimeout(r, POLL_MS));
          continue;
        }
        try { fs.writeFileSync(fd, JSON.stringify({ who, at: Date.now() })); }
        finally { fs.closeSync(fd); }
        try { return await fn(); }
        finally { try { fs.unlinkSync(file); } catch { /* already released */ } }
      }
    },
  };
}
