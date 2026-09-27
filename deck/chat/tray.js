// @ts-check
// What sits above the composer while a session works (the Session board): the live todo list,
// pinned ("Todos 3 of 5 · Running the tests", opening to the list), and the background tasks
// tray (running shells and subagents: View output, Stop). Both read session-state (s.todos,
// s.tasks) and are redrawn when it says "@todos" or "@tasks". Text nodes only.

import { h, put } from "../js/dom.js";
import { since } from "../js/fmt.js";
import { NEEDS_UPDATE } from "./core/caps.js";

/**
 * @typedef {import("./core/session-state.js").Todo} Todo
 * @typedef {import("./core/session-state.js").Task} Task
 */

/** @returns {{ el: HTMLElement, set: (t: { todos: Todo[] }|null) => void }} */
export function todoPin() {
  let open = false;
  /** @type {Todo[]} */
  let todos = [];
  const el = h("div", { class: "cv-pin", hidden: true });
  function draw() {
    const done = todos.filter(t => t.status === "completed").length;
    const now = todos.find(t => t.status === "in_progress") || todos.find(t => t.status === "pending");
    // Shown while something is left to do; a finished list goes with the turn that finished it.
    el.hidden = !todos.length || done === todos.length;
    if (el.hidden) { el.replaceChildren(); return; }
    put(el,
      h("button", { class: "cv-pin-head", type: "button", "aria-expanded": String(open), onclick: () => { open = !open; draw(); } },
        h("span", { class: "lbl" }, "Todos"), h("span", { class: "cv-pin-count" }, `${done} of ${todos.length}`),
        now ? h("span", { class: "cv-pin-now ellipsis" }, now.status === "in_progress" && now.activeForm ? now.activeForm : now.content) : null),
      open ? h("ul", { class: "cv-pin-list" }, todos.map(t => h("li", { class: "cv-pin-todo cv-pin-todo-" + t.status },
        h("span", { class: "cv-pin-box", "aria-hidden": "true" }, t.status === "completed" ? "✓" : ""), h("span", null, t.content)))) : null,
    );
  }
  return { el, set(t) { todos = t && Array.isArray(t.todos) ? t.todos : []; draw(); } };
}

/**
 * @param {{ onView: (t: Task) => void, onKill: (t: Task) => Promise<string|null>, can: () => boolean|null }} o
 *   onKill resolves to an error to show, or null. can: whether the box has threads.kill-task.
 * @returns {{ el: HTMLElement, set: (tasks: Map<string, Task>) => void, draw: () => void, toggle: () => void }}
 */
export function tasksTray(o) {
  /** @type {Task[]} */
  let tasks = [];
  let open = true;
  const errs = new Map();
  const el = h("div", { class: "cv-tasks", hidden: true, role: "region", "aria-label": "Background tasks" });
  function draw(now = Date.now()) {
    const running = tasks.filter(t => t.status === "running");
    // Running ones, then the two that ended last.
    const ended = tasks.filter(t => t.status !== "running").slice(-2);
    const shown = [...running, ...ended];
    el.hidden = !shown.length;
    if (el.hidden) { el.replaceChildren(); return; }
    const off = o.can() === false;
    put(el,
      h("button", { class: "cv-tasks-head", type: "button", "aria-expanded": String(open), onclick: () => { open = !open; draw(); } },
        h("span", { class: "lbl" }, "Background"),
        h("span", { class: "cv-tasks-count" }, running.length ? `${running.length} running` : "none running")),
      open ? shown.map(t => h("div", { class: "cv-task", "data-status": t.status },
        h("span", { class: "cv-task-kind" }, t.kind === "agent" ? "Agent" : "Shell"),
        h("span", { class: "cv-task-title ellipsis" }, t.title),
        h("span", { class: "cv-task-meta" }, [t.status === "running" ? "running" : t.status, t.at ? since(t.at, now) : null].filter(Boolean).join(" · ")),
        t.call ? h("button", { class: "btn btn-ghost btn-sm cv-task-view", type: "button", onclick: () => o.onView(t) }, "View output") : null,
        t.status === "running" ? h("button", { class: "btn btn-ghost btn-sm cv-task-stop", type: "button", disabled: off, title: off ? NEEDS_UPDATE : "Stop this task",
          onclick: async () => { const err = await o.onKill(t); if (err) errs.set(t.id, err); else errs.delete(t.id); draw(); } }, "Stop") : null,
        errs.has(t.id) ? h("span", { class: "err cv-task-err" }, errs.get(t.id)) : null)) : null,
    );
  }
  return {
    el, draw: () => draw(),
    set(map) { tasks = [...map.values()]; draw(); },
    toggle() { open = !open; draw(); },
  };
}
