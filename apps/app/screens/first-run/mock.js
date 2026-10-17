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
  "computer.add": { screen: "computer.add" },
  "phone.add": { screen: "phone.add", link: "https://vyre.run/i/samplephone" },
  ready: { screen: "ready", username: "alex", space: "juniper" },
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
