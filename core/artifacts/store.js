// @ts-check
// The artifacts' version history. Each artifact is its own small git repository with no remote, at
// <data>/store/<project>/<id>/, and every version is a commit. A diff is `git diff`, and going back
// is a new commit with the old content, never a rewrite. One repository per artifact, not one per
// project, so deleting an artifact removes every version of it (a shared history would keep old
// content reachable) and moving one to another project is renaming a folder. It is never inside
// the person's own project repository (plans/artifacts.md, option 5B), and git always runs the one
// safe way (lib/git-safe.js): no hooks, no outside config, no network. Writes to one artifact are
// serialised, so two agents saving at once never race on its index.

import fs from "node:fs";
import path from "node:path";
import { gitAsync } from "../../lib/git-safe.js";

const ID = /^a_[A-Za-z0-9_-]{6,32}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FILE = /^[a-z][a-z0-9-]{0,23}\.[a-z0-9]{1,8}$/;
const SHA = /^[0-9a-f]{40}$/;
const WHO = ["-c", "user.name=Vyre", "-c", "user.email=artifacts@vyre.invalid", "-c", "commit.gpgsign=false"];

const bad = (/** @type {string} */ message) => Object.assign(new Error(message), { code: "bad_input" });

/** @param {string} root */
export function openStore(root) {
  /** @type {Map<string, Promise<any>>} */
  const queues = new Map();
  /** @template T @param {string} key @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (key, fn) => {
    const prev = queues.get(key) || Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.then(() => {}, () => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return p;
  };

  /** @param {string} project @param {string} id */
  const repo = (project, id) => {
    if (!PROJECT.test(project)) throw bad(`bad project ${project}`);
    if (!ID.test(id)) throw bad(`bad artifact id ${id}`);
    return path.join(root, project, id);
  };

  /** @param {string} dir @param {string[]} args */
  const git = async (dir, args) => {
    const r = await gitAsync(dir, [...WHO, ...args]);
    if (!r.ok) throw Object.assign(new Error(`history: ${r.stderr.trim().split("\n")[0] || "git failed"}`), { code: "store_failed" });
    return r.stdout;
  };

  return {
    /**
     * Replace the artifact's files with `files` and commit, making the repository on first use.
     * Returns the new commit's sha.
     * @param {string} project @param {string} id @param {Record<string,string>} files @param {string} message
     */
    write: (project, id, files, message) => {
      const dir = repo(project, id);
      for (const name of Object.keys(files)) if (!FILE.test(name)) throw bad(`bad file name ${name}`);
      return serial(dir, async () => {
        if (!fs.existsSync(path.join(dir, ".git"))) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          await git(dir, ["init", "-q", "-b", "main"]);
        }
        for (const e of fs.readdirSync(dir)) if (e !== ".git") fs.rmSync(path.join(dir, e), { recursive: true, force: true });
        for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, { mode: 0o600 });
        await git(dir, ["add", "-A"]);
        await git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
        return (await git(dir, ["rev-parse", "HEAD"])).trim();
      });
    },

    /** The artifact's files at a version. @param {string} project @param {string} id @param {string} sha
     * @returns {Promise<Record<string,string>>} */
    read: async (project, id, sha) => {
      const dir = repo(project, id);
      if (!SHA.test(sha)) throw bad("bad version");
      const names = (await git(dir, ["ls-tree", "--name-only", sha])).split("\n").filter(n => FILE.test(n));
      /** @type {Record<string,string>} */
      const out = {};
      for (const n of names) out[n] = await git(dir, ["show", `${sha}:${n}`]);
      return out;
    },

    /** A unified diff between two versions. @param {string} project @param {string} id @param {string} a @param {string} b */
    diff: async (project, id, a, b) => {
      const dir = repo(project, id);
      if (!SHA.test(a) || !SHA.test(b)) throw bad("bad version");
      return git(dir, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", a, b]);
    },

    /** Move an artifact, with its whole history, to another project. @param {string} from @param {string} to @param {string} id */
    move: (from, to, id) => {
      const a = repo(from, id), b = repo(to, id);
      return serial(a, async () => {
        if (fs.existsSync(b)) throw Object.assign(new Error(`${id} is already in ${to}`), { code: "exists" });
        fs.mkdirSync(path.dirname(b), { recursive: true, mode: 0o700 });
        fs.renameSync(a, b);
      });
    },

    /** Remove an artifact and every version of it, for good. @param {string} project @param {string} id */
    purge: (project, id) => {
      const dir = repo(project, id);
      return serial(dir, async () => { fs.rmSync(dir, { recursive: true, force: true }); });
    },
  };
}
