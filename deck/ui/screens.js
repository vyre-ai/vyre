// @ts-check
// deck/ui/screens: the generated screens, by name. /u/<screen>/<a>/<b> opens the one named here (views/ui.js). Each is a module in views/ whose default export
// draws into ctx.root and reads ctx.params ({ screen, a, b }); each owns its stylesheet (css/ui*.css, loaded for every page, tokens only).
/** @type {Record<string, () => Promise<{ default: (ctx: any) => any }>>} */
export const screens = {
  now: () => import("../views/ui-now.js"),
  task: () => import("../views/ui-task.js"),
  project: () => import("../views/ui-project.js"),
  projects: () => import("../views/ui-projects.js"),
  records: () => import("../views/ui-records.js"),
  record: () => import("../views/ui-record.js"),
  appearance: () => import("../views/ui-appearance.js"),
};
