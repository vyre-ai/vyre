#!/usr/bin/env python3
"""After a merge on the trunk: for the shared files, list every line a parent ADDED (against the merge base) that the merge result lacks.
Usage: scripts/devbox-merge-check.py [merge-commit]   (default HEAD). Prints the file, which parent, and the lines; exit 1 when any."""
import subprocess, sys
SHARED = ["core/daemon/index.js", "core/modules/index.js", "kernel/home.js", "kernel/index.js", "kernel/gateway/index.js", "kernel/gateway/records.js", "core/wink/pairing.js", "core/presence/module.js"]
def g(*a): return subprocess.run(["git", *a], capture_output=True, text=True).stdout
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
  ["kernel/seal/wire.js", r"canonical\(\{ op, space, fields \}\)", "the nested approval payload hash"],
]
for f, rx, what in MUST:
    txt = g("show", f"{m}:{f}")
    if txt and not re.search(rx, txt):
        bad += 1; print(f"MUST-SURVIVE MISSING in {f}: {what}")
print("merge-check:", "LINES DROPPED" if bad else "clean")
sys.exit(1 if bad else 0)
