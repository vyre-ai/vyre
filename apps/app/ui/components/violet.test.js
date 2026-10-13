// Violet means "needs you" and nothing else: the on, selected, checked, progress and focus states of the library are the neutral strong ink (primary, selected), never the accent.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(UI, f), "utf8");
const NEUTRAL = ["components/Switch.tsx", "components/Menu.tsx", "components/PickerList.tsx", "components/RolePicker.tsx", "components/ChoiceList.tsx", "components/Meter.tsx", "components/PasswordField.tsx", "components/StageSteps.tsx", "components/Tabs.tsx", "components/Field.tsx", "components/Composer.tsx", "shell/SidebarRow.tsx", "tasks/ProjectsList.tsx", "views/DashboardView.tsx", "views/CalendarView.tsx", "blocks/BlockViews.tsx", "blocks/BlockViews2.tsx"];

test("the on, selected, checked, progress and focus states do not use the accent", () => {
  const bad = NEUTRAL.filter((f) => /color\.accent\b|color\["accent|bg-accent|border-accent|tone="accent"|tone=\{[^}]*"accent"/.test(read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  assert.deepEqual(bad, [], "these still draw a state in violet");
});

test("a selected chip is the neutral selected wash, and a token chip's accent tone is neutral too", () => {
  const chip = read("components/Chip.tsx");
  assert.match(chip, /const t = selected \? "selected"/);
  assert.match(chip, /selected: "bg-selected"/);
  assert.match(read("components/ChipToken.tsx"), /tone === "accent" \? color\.selected/);
});
