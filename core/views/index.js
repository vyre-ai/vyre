// @ts-check
// views: the app's side of a module's `views` (the Capsule's view language, promoted to the whole app; docs/MODULES.md "Views").
//
//   views.list  every view the running modules declare: [{ module, id, title, keywords, icon, kind, root, arg, firstParty, hash }]
//   views.get   one frame for a view: list, board, summary, detail or form (or error, needs, held), from the module's own tool; rows carry action ids, never tool names
//   views.act   what an action does: done, view, preview, push, held, needs or error. An outward action previews its exact words first; the second call must return the preview's token.
//
// The same engine answers the Capsule as capsule.commands, capsule.view and capsule.act (local/capsule), from the same declaration: `views` in the manifest, with shows.capsule's `view:<id>` entries as
// the older name for it. A module's own code never runs in the app: it describes, and the app draws the frame.
import { registerViews } from "./engine.js";

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    registerViews(ctx, { names: { commands: "views.list", view: "views.get", act: "views.act" }, surface: "app", mcp: false });
    return { async stop() {} };
  },
};
