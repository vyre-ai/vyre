import { useEffect, useState } from "react";
import { View } from "react-native";
import { createMockStore } from "../../src/store-core/mock-store.js";
import { loadWorld } from "../../ui/tasks/world.js";
import { nowModel, type World } from "../../ui/tasks/model";
import { agentCards, homeName } from "./home-model.js";
import { HomeHeader } from "./HomeHeader";
import { HomeComposer } from "./AskDock";
import { HomeColumn } from "./HomeSection";
import { HomeBody } from "./HomeBody";

/** Sunday 18 October 2026, mid-afternoon UTC, so the date and the greeting stay still in a picture. */
const NOW = Date.UTC(2026, 9, 18, 15, 0, 0);

/** The assistant, then agents the person made, plus the Engineer so a picture can show that chip is absent. */
const SAMPLE = agentCards([
  { name: "alex", kind: "assistant", doing: "idle" },
  { name: "engineer", doing: "working" },
  { name: "kit", doing: "idle" },
  { name: "juno", doing: "idle" },
]);

/** A short busy day: one thing that needs you, one agent working, one finished, two events, a little recent. */
function forPicture(w: World, day: "quiet" | "busy"): World {
  if (day === "quiet") return { ...w, tasks: [], events: [], calendar: [] };
  const m = nowModel(w);
  const needs = m.needs.slice(0, 1);
  const working = m.working.filter((t) => !m.needIds.has(t.id)).slice(0, 1);
  const done = m.doneToday.slice(0, 1);
  const ids = new Set([...needs, ...working, ...done].map((t) => t.id));
  return { ...w, tasks: w.tasks.filter((t) => ids.has(t.id)), events: w.events.slice(-4), calendar: (w.calendar ?? []).slice(0, 2) };
}

/** Home as the gallery draws it: a quiet day, or a day with each section. No scroll view, so the picture is the whole column. */
export function HomePreview({ day }: { day: "quiet" | "busy" }) {
  const [world, setWorld] = useState<World | undefined>(undefined);
  useEffect(() => {
    let on = true;
    const store = createMockStore({ world: day === "quiet" ? "empty" : "morning", crm: false, now: () => NOW });
    void loadWorld(store, () => NOW).then((w) => { if (on) setWorld(forPicture(w as World, day)); });
    return () => { on = false; };
  }, [day]);
  const person = world?.actors.find((a) => a.id === world.me);
  const name = homeName(person?.family === "person" ? { label: person.name } : null);
  return (
    <HomeColumn>
      <View className="gap-s4">
        <HomeHeader name={name} now={world?.now ?? NOW} zone="UTC" />
        <HomeComposer cards={SAMPLE} />
      </View>
      {world ? <HomeBody world={world} items={world.calendar ?? []} onAction={() => {}} onOpen={() => {}} /> : null}
    </HomeColumn>
  );
}
