#!/usr/bin/env python3
"""After a merge on the trunk: for the shared files, list every line a parent ADDED (against the merge base) that the merge result lacks.
Usage: scripts/devbox-merge-check.py [merge-commit]   (default HEAD). Prints the file, which parent, and the lines; exit 1 when any.
Before the commit is made (merge in progress, conflicts resolved): scripts/devbox-merge-check.py --worktree  refuses a leftover conflict marker in any file the merge touches."""
import subprocess, sys
SHARED = ["core/daemon/index.js", "core/modules/index.js", "kernel/home.js", "kernel/index.js", "kernel/gateway/index.js", "kernel/gateway/records.js", "core/wink/pairing.js", "core/presence/module.js"]
def g(*a): return subprocess.run(["git", *a], capture_output=True).stdout.decode("utf-8", "replace")
import re
MARK = re.compile(r"^(<<<<<<<( |$)|>>>>>>>( |$)|=======$)", re.M)
def markers(text, name):
    """Conflict markers at line start: an opening or closing marker, or a bare ======= line that sits between an opening and a closing one."""
    hits = []; inside = False
    for n, l in enumerate(text.split("\n"), 1):
        if re.match(r"<<<<<<<( |$)", l): inside = True; hits.append((n, l))
        elif re.match(r">>>>>>>( |$)", l): inside = False; hits.append((n, l))
        elif l == "=======" and inside: hits.append((n, l))
    return hits
if len(sys.argv) > 1 and sys.argv[1] == "--worktree":
    names = set(g("diff", "--name-only", "HEAD").split()) | set(g("diff", "--name-only", "--diff-filter=U").split()) | set(g("diff", "--name-only", "--cached").split())
    nb = 0
    for f in sorted(names):
        try: t = open(f, errors="replace").read()
        except OSError: continue
        for n, l in markers(t, f): nb += 1; print(f"CONFLICT MARKER {f}:{n}: {l[:60]}")
    print("merge-check --worktree:", "CONFLICT MARKERS LEFT" if nb else "no conflict markers"); sys.exit(1 if nb else 0)
m = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
ps = g("rev-list", "--parents", "-n1", m).split()[1:]
if len(ps) != 2: print("not a two-parent merge"); sys.exit(0)
p1, p2 = ps
base = g("merge-base", p1, p2).strip()
files = list(SHARED) + [f for f in g("diff", "--name-only", base, m).split() if f.endswith("module.json") and f not in SHARED]
bad = 0
for f in files:
    res = g("show", f"{m}:{f}")
    if not res: continue
    have = set(l.strip() for l in res.split("\n"))
    for who, p in (("parent1 (trunk)", p1), ("parent2 (merged branch)", p2)):
        d = g("diff", "-U0", base, p, "--", f)
        added = [l[1:] for l in d.split("\n") if l.startswith("+") and not l.startswith("+++")]
        miss = [l for l in added if l.strip() and l.strip() not in have and len(l.strip()) > 3]
        if miss:
            bad += 1
            print(f"{f}: {len(miss)} line(s) added by {who} are missing from the result")
            for l in miss[:12]: print("    " + l[:170])
# A conflict marker left in any file the merge changed (a merge once reached the pushed history with markers in test/wink.test.js)
for f in g("diff", "--name-only", base, m).split():
    t = g("show", f"{m}:{f}")
    for n, l in markers(t, f): bad += 1; print(f"CONFLICT MARKER in the merge result {f}:{n}: {l[:60]}")
# Lines that must survive every merge (each one was silently dropped by a merge once, 4 Oct): [file, regex, what]
import re
MUST = [
  ["core/daemon/index.js", r"registry\.deps\.peerDoor\s*=", "the peer door mount (MG-1)"],
  ["core/daemon/index.js", r"createOwnServerHost", "the own-server wiring on runnerHost"],
  ["core/switchboard/index.js", r"async \(i, meta = \{\}\) => \{ const \{ caller, idempotencyKey, firstParty, peer \} = meta", "threads.send takes meta (the `meta is not defined` break)"],
  ["kernel/home.js", r"onOwnerAdopted", "kernel/home.js onOwnerAdopted (the claim waits for hosted-space adoption)"],
  ["core/modules/index.js", r"\.\.\.\(terminal \? \{ terminal \} : \{\}\)", "meta.terminal reaches the tool (vyre signin)"],
  ["core/wink/module.json", r"wink\.server\.owner", "wink.server.owner"],
  ["core/wink/module.json", r"wink\.server\.probe", "wink.server.probe"],
  ["core/daemon/index.js", r"createPeerDoor\(\{[^}]*\bevents\b[^}]*\bidentityEntry\b|createPeerDoor\(\{[^}]*\bidentityEntry\b[^}]*\bevents\b", "the peer door mount passes events AND identityEntry/boxId (streams and the invitee door)"],
  ["core/relay/index.js", r"only\(meta, \[\"names\", \"wink\", \"vyred\"\], \"the route id\"\)", "relay.route.id answers module:vyred (the invitee door reads the box id)"],
  ["kernel/seal/wire.js", r"canonical\(\{ op, space, fields \}\)", "the nested approval payload hash"],
]
for f, rx, what in MUST:
    txt = g("show", f"{m}:{f}")
    if txt and not re.search(rx, txt):
        bad += 1; print(f"MUST-SURVIVE MISSING in {f}: {what}")
print("merge-check:", "LINES DROPPED" if bad else "clean")
sys.exit(1 if bad else 0)
