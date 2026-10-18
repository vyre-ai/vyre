// @ts-check
// Sample first-run screens for mock builds only (?shot=). A real build never imports this table.

export const SHOT_TABLE = {
  "id.create": { screen: "id.create", username: "alex" },
  "id.recovery": { screen: "id.recovery", username: "alex", recovery: "R1-SAMPLE-KEY-SHOWN-ONCE" },
  "id.ai": { screen: "id.ai", username: "alex" },
  "space.choice": { screen: "space.choice", username: "alex" },
  "join.link": { screen: "join.link" },
  "join.review": { screen: "join.review", link: "https://vyre.run/i/sampletoken", space: "juniper" },
  "create.kind": { screen: "create.kind" },
  "create.wait": { screen: "create.wait", command: "curl -fsSL vyre.run/i | sh" },
  "invite.share": { screen: "invite.share", link: "https://vyre.run/i/sampletoken", space: "juniper" },
  ready: { screen: "ready", username: "alex", space: "juniper" },
  // the welcome flow's newer screens (the sample world's pictures; nothing here is real)
  "id.name": { screen: "id.name", first: "Ada", last: "Lovelace" },
  "id.password": { screen: "id.password", username: "ada" },
  "setup.assistant": { screen: "setup.assistant", username: "ada", asName: "Juno" },
  "setup.assistant.keep": { screen: "setup.assistant", username: "ada", another: true, space: "ivy-labs", carried: { name: "Juno", look: "s2~c3~e1~m0~t1~b0~h2" } },
  "setup.model": { screen: "setup.model", username: "ada", asName: "Juno", models: [{ id: "ac_1", label: "Claude Work", provider: "claude", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] }, { id: "ac_2", label: "Codex key", provider: "codex", models: [{ id: "gpt-5", label: "GPT 5" }] }] },
  "ready.assistant": { screen: "ready", username: "ada", space: "juniper", asDone: true, asName: "Juno" },
  "copy.normal": { screen: "id.ai", username: "ada", another: true, space: "ivy-labs", copyable: { from: "Juniper Studio", accounts: [{ id: "a1", label: "Claude Work", provider: "claude", copy: true }, { id: "a2", label: "Router", provider: "openrouter", copy: true }, { id: "a3", label: "Codex login", provider: "codex", copy: false, why: "Sign in again on the new Space." }] }, copyPick: ["a1", "a2"] },
  "copy.partial": { screen: "id.ai", username: "ada", another: true, space: "ivy-labs", copyable: { from: "Juniper Studio", accounts: [{ id: "a1", label: "Claude Work", provider: "claude", copy: true }, { id: "a2", label: "Router", provider: "openrouter", copy: true }, { id: "a3", label: "Grok", provider: "openai-compatible", copy: true }] }, copyPick: ["a1", "a2", "a3"], copyDone: [{ id: "a1", label: "Claude Work", ok: true }, { id: "a2", label: "Router", ok: false, why: "Not approved. Sign in again on the new Space, or try the copy again." }, { id: "a3", label: "Grok", ok: false, why: "Not copied" }] },
  "copy.hand": { screen: "id.ai", username: "ada", another: true, space: "ivy-labs", copyable: { from: "Juniper Studio", accounts: [{ id: "a1", label: "My lab server", provider: "openai-compatible", copy: false, why: "Add this one by hand." }, { id: "a2", label: "Claude Work", provider: "claude", copy: true }] } },
  "copy.notyours": { screen: "id.ai", username: "ada", another: true, space: "ivy-labs", copyable: { from: "Juniper Studio", accounts: [{ id: "a1", label: "Team shared", provider: "claude", copy: false, why: "Not yours to copy." }, { id: "a2", label: "Claude Work", provider: "claude", copy: true }] } },
};

export const GITHUB_MOCK = {
  linked: { id: 4242, login: "alex-gh", displayName: "Alex Rivera", avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4", linkedName: "alex" },
  fresh: { id: 9001, login: "sam-builds", displayName: "Sam Okafor", avatarUrl: "https://avatars.githubusercontent.com/u/9001?v=4" },
};

/** @param {unknown} login */
export const nameFromLogin = (login) => {
  const n = String(login ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 20);
  return /^[a-z][a-z0-9-]{2,19}$/.test(n) ? n : "";
};
