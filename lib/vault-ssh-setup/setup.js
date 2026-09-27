// @ts-check
// setup: what a person runs so ssh and git use vyred's agent, and which keys in ~/.ssh can move in.
//
// Vyre never edits ~/.ssh/config or a shell profile: it prints the lines. Git's own settings are
// changed only when the person asks (`vyre vault ssh setup --git`), with the commands shown first.
// Commit signing goes through the agent (gpg.format ssh, user.signingkey "key::<public key>"),
// and every signature asks, as ADR 0006 says. Pure, apart from findPrivateKeys reading a folder.

import fs from "node:fs";
import path from "node:path";

/**
 * @param {{ socket: string, pub: string, email?: string, allowedSigners: string }} o
 * @returns {{ ssh: string[], shell: string[], git: string[][], allowed: string|null }}
 */
export function setupPlan({ socket, pub, email, allowedSigners }) {
  const key = pub.trim().split(/\s+/).slice(0, 2).join(" ");
  return {
    ssh: ["Host *", `  IdentityAgent "${socket}"`],
    shell: [`export SSH_AUTH_SOCK="${socket}"`],
    git: [
      ["config", "--global", "gpg.format", "ssh"],
      ["config", "--global", "user.signingkey", `key::${key}`],
      ["config", "--global", "commit.gpgsign", "true"],
      ["config", "--global", "tag.gpgsign", "true"],
      ["config", "--global", "gpg.ssh.allowedSignersFile", allowedSigners],
    ],
    allowed: email ? `${email} namespaces="git" ${key}` : null,
  };
}

/** Add a line to the allowed-signers file unless it is there already. 0600, made if missing. */
export function addAllowedSigner(file, line) {
  let have = "";
  try { have = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  if (have.split(/\r?\n/).some(l => l.trim() === line.trim())) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (have && !have.endsWith("\n") ? have + "\n" : have) + line + "\n", { mode: 0o600 });
  return true;
}

const PRIVATE = /^-----BEGIN (OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----/;

/**
 * Private keys in a folder (~/.ssh), by their first line, never following links, with the item
 * name each would get. Public halves, known_hosts, config and certificates are left alone.
 * @param {string} dir
 * @returns {{ file: string, name: string }[]}
 */
export function findPrivateKeys(dir) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of list.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isFile() || ent.name.endsWith(".pub") || /^(known_hosts|config|authorized_keys)/.test(ent.name) || ent.name.includes("-cert")) continue;
    const p = path.join(dir, ent.name);
    let head = "";
    try {
      const fd = fs.openSync(p, "r");
      try { const b = Buffer.alloc(64); head = b.subarray(0, fs.readSync(fd, b, 0, 64, 0)).toString("utf8"); } finally { fs.closeSync(fd); }
    } catch { continue; }
    if (!PRIVATE.test(head)) continue;
    out.push({ file: p, name: `ssh-${ent.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "")}`.slice(0, 128) });
  }
  return out;
}
