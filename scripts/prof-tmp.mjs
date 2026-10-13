import fs from "node:fs";
const dir = process.argv[2];
const f = fs.readdirSync(dir).filter(x => x.endsWith(".cpuprofile")).map(x => dir + "/" + x).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
const p = JSON.parse(fs.readFileSync(f, "utf8"));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map(); for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
let t = p.startTime; const slices = [];
for (let i = 0; i < p.samples.length; i++) { t += p.timeDeltas[i]; slices.push([(t - p.startTime) / 1e6, p.samples[i], p.timeDeltas[i] / 1000]); }
const label = id => { const n = byId.get(id); const c = n.callFrame; return `${c.functionName || "(anon)"} ${c.url.replace(/.*\/vyre\/(?:vyre\/)?/, "")}:${c.lineNumber + 1}`; };
const top = (from, to, k) => { const m = new Map(); let tot = 0; for (const [s, id, ms] of slices) if (s >= from && s < to) { const l = label(id); if (/\(idle\)|\(program\)/.test(l)) continue; m.set(l, (m.get(l) || 0) + ms); tot += ms; } return `${from}-${to}s total ${tot.toFixed(0)}ms\n` + [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, v]) => `   ${v.toFixed(0)}ms ${l}`).join("\n"); };
console.log(top(0, 14, 12)); console.log(top(14, 28, 6)); console.log(top(28, 60, 8)); console.log(top(60, 100, 8));
