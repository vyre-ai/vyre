import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { settingOf, usable, accountOptions, accountLine, limitOptions, reportValue, reportLine, startLine, refusal, REPORTS } from "./agent-work-model.ts";

const rows = [
  { id: "a1", provider: "claude", label: "Work Claude", kind: "login", is_default: true, signed_in_at: 1 },
  { id: "a2", provider: "claude", label: "Setup token", kind: "setup-token", vault_item: "tok", signed_in_at: 1 },
  { id: "x1", provider: "codex", label: "Codex", kind: "login", signed_in_at: 1 },
  { id: "p1", provider: "claude", label: "Waiting", kind: "login", pending: true },
  { id: "default", provider: "claude", label: "Default", kind: "login", synthetic: true },
];

test("only the viewer's signed-in Claude accounts are offered, the default first and named", () => {
  const a = usable(rows);
  assert.deepEqual(a.map((x) => x.id), ["a1", "a2"]);
  assert.deepEqual(accountOptions(a), [["", "My default account (Work Claude)"], ["a1", "Work Claude"], ["a2", "Setup token"]]);
});

test("the setting is read from the tool's answer, and the lines say what it means", () => {
  const s = settingOf({ account: "a1", person: "per_x", daily_limit: 50, report_hours: 0, agent_pick: false });
  assert.deepEqual(s, { account: "a1", person: "per_x", dailyLimit: 50, reportHours: 0, agentPick: false });
  assert.match(accountLine(s, usable(rows)), /work on Work Claude/);
  assert.match(accountLine(settingOf({ account: "zz" }), usable(rows)), /not one of yours/);
  assert.match(accountLine(settingOf({}), []), /Add an AI account under Settings/);
  assert.equal(reportLine(0), "The project lead writes no regular report.");
  assert.match(reportLine(null), /every day/);
  assert.equal(reportValue(null), "24");
  assert.ok(REPORTS.some(([v, l]) => v === "0" && l === "Off"));
});

test("the limit choices keep the current value and sort", () => {
  assert.deepEqual(limitOptions(null).map(([v]) => v), ["25", "50", "100", "250", "500", "1000"]);
  assert.ok(limitOptions(75).some(([v]) => v === "75"));
});

test("the line at project start and the refusals say the next step", () => {
  assert.match(startLine(null), /account of the person who gives them each task.*Team, Agent work/);
  assert.match(startLine("Work Claude"), /work on Work Claude/);
  assert.match(refusal("not_found", ""), /Pick one from the list/);
  assert.match(refusal("denied", ""), /Sign in as yourself/);
});
