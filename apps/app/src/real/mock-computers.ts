// The agent computer and a chat's background tasks answered from memory, for the sample build (EXPO_PUBLIC_VYRE_MOCK=1) only. "ads" has a live screen, "kit" is asleep, and waking one takes three seconds, so the
// Computer tab can be seen in all three states. The shapes are the agent computer's (computers.agent.*).
type S = { state: "none" | "asleep" | "waking" | "live"; since: number; last: number };
const now = () => Date.now();
const gone = new Set<string>();
const W: Record<string, S> = { juno: { state: "live", since: 0, last: now() }, ads: { state: "live", since: 0, last: now() }, kit: { state: "asleep", since: 0, last: now() - 3_600_000 } };
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#f4f1ea"/><rect width="640" height="34" fill="#dcd8cf"/><circle cx="18" cy="17" r="5" fill="#b9b4a8"/><circle cx="36" cy="17" r="5" fill="#b9b4a8"/><circle cx="54" cy="17" r="5" fill="#b9b4a8"/><rect x="90" y="8" width="300" height="18" rx="9" fill="#f4f1ea"/><rect x="24" y="60" width="180" height="16" rx="4" fill="#2b2a27"/><rect x="24" y="96" width="592" height="40" rx="6" fill="#e6e2d8"/><rect x="24" y="148" width="592" height="40" rx="6" fill="#e6e2d8"/><rect x="24" y="200" width="592" height="40" rx="6" fill="#e6e2d8"/><rect x="24" y="270" width="120" height="60" rx="6" fill="#cfcabd"/><rect x="156" y="270" width="120" height="60" rx="6" fill="#cfcabd"/><rect x="288" y="270" width="120" height="60" rx="6" fill="#cfcabd"/></svg>`;
const THUMB = `data:image/svg+xml;base64,${typeof btoa === "function" ? btoa(svg) : ""}`;
const settle = (a: string): S => { const s = (W[a] ??= { state: "none", since: 0, last: 0 }); if (s.state === "waking" && now() - s.since > 3000) { s.state = "live"; } return s; };
const shape = (s: S) => ({ state: s.state, lastActive: s.last, display: s.state === "live" ? 1 : null, ...(s.state === "live" ? { thumbnail: THUMB } : {}) });

export const mockComputerTools: Record<string, (i: any) => unknown> = {
  "computers.agent.status": (i) => shape(settle(String(i.agent))),
  "computers.agent.wake": (i) => { const s = settle(String(i.agent)); if (s.state === "asleep" || s.state === "none") { s.state = "waking"; s.since = now(); } s.last = now(); return shape(s); },
  "computers.agent.sleep": (i) => { const s = settle(String(i.agent)); s.state = "asleep"; return shape(s); },
  "gate.standing.list": (i) => ({ permissions: String(i.agent) === "juno" ? [{ id: "g1", agent: "juno", resource: "vyre://spc/outbox/send/gmail", to: { patterns: ["*@northwind.example"] }, daily_cap: 20 }, { id: "g2", agent: "juno", resource: "vyre://spc/outbox/spend/meta", to: { patterns: ["Meta Ads"] }, max_amount: 200, daily_amount: 500 }].filter((p) => !gone.has(p.id)) : [] }),
  "gate.standing.revoke": (i) => { gone.add(String(i.id)); return { revoked: String(i.id) }; },
  "projects.list": () => ({ projects: [{ slug: "northwind", name: "Northwind Bakery" }, { slug: "juniper", name: "Juniper Studio" }, { slug: "okafor", name: "Okafor estate" }] }),
  "agents.create": (i) => ({ name: String(i.name), kind: "agent", uid: `agt_${String(i.name)}` }),
  "threads.tasks": () => [
    { id: "t1", kind: "agent", title: "Pull last week's spend by campaign", status: "running" },
    { id: "t2", kind: "agent", title: "Check audience overlap between two ad sets", status: "done" },
    { id: "t3", kind: "bash", title: "npm run report", status: "running" },
  ],
};
