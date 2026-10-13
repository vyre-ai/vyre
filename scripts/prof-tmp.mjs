import fs from "node:fs";
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map(); for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
let t = 0; const ev = [];
for (let i = 0; i < p.samples.length; i++) { t += p.timeDeltas[i]; ev.push([t / 1e6, p.samples[i], p.timeDeltas[i] / 1000]); }
const lab = id => { const c = byId.get(id).callFrame; return `${c.functionName || "(anon)"} ${c.url.replace(/.*\/vyre\//, "")}:${c.lineNumber + 1}`; };
const stack = id => { const o = []; for (let x = id; x && o.length < 7; x = parent.get(x)) o.push(lab(x)); return o.join(" < "); };
const b = new Map();
for (const [s, id, ms] of ev) { const l = lab(id); if (/\(idle\)|\(program\)/.test(l)) continue; const k = Math.floor(s * 2) / 2; if (!b.has(k)) b.set(k, []); b.get(k).push([id, ms]); }
for (const [k, arr] of [...b].sort((x, y) => x[0] - y[0])) {
  const tot = arr.reduce((a, x) => a + x[1], 0); if (tot < 15) continue;
  const m = new Map(); for (const [id, ms] of arr) m.set(id, (m.get(id) || 0) + ms);
  console.log(`t+${k}s ${tot.toFixed(0)}ms`);
  for (const [id, ms] of [...m].sort((a, c) => c[1] - a[1]).slice(0, 3)) console.log(`    ${ms.toFixed(0)}ms ${stack(id)}`);
}
