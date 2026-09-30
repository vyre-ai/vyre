// @ts-check
// manifest: what the assistant can do on this install right now, built from the registry and
// never written by hand. A source that does not answer is dropped, not guessed. Only working
// things are listed; a missing one appears as "not connected: say X", never as a tool.

const AREAS = ["tools", "connectors", "devices", "agents", "providers"];
export const BUDGET_CHARS = 6000; // about 1,500 tokens

/** @param {(tool: string, input?: any) => Promise<any>} call @param {string} tool @param {any} [input] */
const read = async (call, tool, input = {}) => {
  const r = await call(tool, input).catch(() => null);
  return r && !r.error ? r.data : null;
};

/** @param {(tool: string, input?: any) => Promise<any>} call @param {string} [area] */
export async function capabilities(call, area) {
  if (area !== undefined && !AREAS.includes(area)) throw new Error(`area must be one of ${AREAS.join(", ")}`);
  const want = a => !area || area === a;
  const out = {};
  const missing = [];
  if (want("tools")) {
    const d = await read(call, "modules.capabilities", { caller: "assistant" });
    out.tools = Array.isArray(d) ? d : d && Array.isArray(d.modules) ? d.modules : [];
  }
  if (want("connectors")) {
    const d = await read(call, "mcp.servers");
    const rows = Array.isArray(d) ? d : [];
    out.connectors = rows.map(s => ({ name: s.name, state: s.state, tools: s.tools ?? null, working: s.state === "running" }));
    for (const s of out.connectors) if (!s.working) missing.push(`${s.name} is ${s.state === "failed" ? "broken" : "not connected"}: say "connect ${s.name}"`);
  }
  if (want("devices")) {
    const [macs, phones] = await Promise.all([read(call, "link.macs"), read(call, "push.devices")]);
    const list = a => Array.isArray(a) ? a : a && Array.isArray(a.macs) ? a.macs : [];
    out.devices = [
      ...list(macs).map(m => ({ name: m.node || m.name || "Mac", kind: "mac", online: Boolean(m.online) })),
      ...list(phones).map(p => ({ name: p.label || "phone", kind: "phone", last_seen: p.last_ok || null })),
    ];
  }
  if (want("agents")) {
    const [agents, team] = await Promise.all([read(call, "agents.list"), read(call, "team.list")]);
    out.agents = (Array.isArray(agents) ? agents : []).map(a => ({ name: a.name, kind: a.kind, doing: a.doing }));
    out.teammates = (Array.isArray(team) ? team : team && Array.isArray(team.teammates) ? team.teammates : [])
      .map(x => ({ name: x.name, project: x.project, role: x.role, state: x.state }));
  }
  if (want("providers")) {
    const d = await read(call, "providers.list");
    out.providers = (Array.isArray(d) ? d : []).map(p => ({ name: p.name, account: p.account || null }));
  }
  return { ...out, not_connected: missing };
}

/** The compact block for the append prompt: short lines, working things only, capped. */
export function render(cap) {
  const lines = [];
  const tools = cap.tools || [];
  if (tools.length) lines.push("Tools: " + tools.map(m => `${m.module || m.name}: ${(m.tools || []).join(", ")}`).join("; "));
  const on = (cap.connectors || []).filter(c => c.working).map(c => c.name);
  if (on.length) lines.push("Connected: " + on.join(", "));
  const dev = (cap.devices || []).map(d => `${d.name} (${d.kind}${d.kind === "mac" ? d.online ? ", online" : ", offline" : ""})`);
  if (dev.length) lines.push("Devices: " + dev.join(", "));
  const ag = (cap.agents || []).filter(a => a.kind !== "assistant").map(a => a.name);
  if (ag.length) lines.push("Agents: " + ag.join(", "));
  const tm = (cap.teammates || []).map(x => `${x.name} (${x.project})`);
  if (tm.length) lines.push("Teammates: " + tm.join(", "));
  const pv = (cap.providers || []).map(p => p.name);
  if (pv.length) lines.push("Providers: " + pv.join(", "));
  for (const m of cap.not_connected || []) lines.push("Not connected: " + m);
  let text = lines.join("\n");
  if (text.length > BUDGET_CHARS) text = text.slice(0, BUDGET_CHARS - 1).replace(/\n[^\n]*$/, "") + "\n";
  return text;
}
