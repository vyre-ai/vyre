// @ts-check
// builder: answers Publish's `builder.build`. Today it reads a folder of ready files (lib/publish/folder-build.js) and runs nothing; a repo, a Drive folder or a build command is refused in plain words
// that name what is missing, never silently skipped. The container builder (BuildKit, core/publish/builder-plan.js) answers the same tool when it exists.

import { readSite, digestOf } from "../../lib/publish/folder-build.js";

const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const NEEDS_CONTAINER = "this server builds a folder of ready files; a repo, a Drive folder or a build command needs the container builder, which is not installed here yet";

/** What a deployment asks of a build, and the plain refusal when it is more than this builder does. @param {any} d @returns {{ dir: string, outputDir: string }} */
export function planOf(d) {
  const src = (d && d.source) || {}, b = (d && d.build) || {};
  if (src.kind !== "folder") throw refuse(NEEDS_CONTAINER, "refused");
  if (b.command) throw refuse(`a build command (${String(b.command).slice(0, 40)}) needs the container builder, which is not installed here yet; publish a folder of ready files instead`, "refused");
  if (b.image && b.image !== "static") throw refuse(`the ${b.image} image needs the container builder, which is not installed here yet`, "refused");
  return { dir: String(src.ref || ""), outputDir: String(b.output_dir || ".") };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.tool("builder.build", {
      internal: true,
      description: "Build a deployment for Publish: a folder of ready files becomes the site's files and digest. Anything that needs a command is refused with what is missing.",
      callers: ["module"],
      input: { type: "object", properties: { deployment: { type: "object" }, secretArgs: { type: "array", items: { type: "string" } } }, required: ["deployment"] },
      run: async (/** @type {any} */ i) => {
        const { dir, outputDir } = planOf(i.deployment);
        let site;
        try { site = readSite({ dir, outputDir }); } catch (/** @type {any} */ e) { throw refuse(e && e.message ? String(e.message) : "the folder could not be read", e && e.code ? String(e.code) : "failed"); }
        // a React page (index.jsx or App.tsx with no index.html) is published as the Preview pane shows it: the previews module makes the page, the compiled files and the libraries it uses
        let files = site.files, built = "";
        if (files.some((/** @type {any} */ f) => /\.(jsx|tsx|ts)$/i.test(f.path))) {
          const r = /** @type {any} */ (await ctx.call("previews.site", { files }));
          if (r && r.error && /^(no_such_tool|not_available)$/.test(String(r.error.code))) throw refuse("a React page needs the previews module, which is not here; publish a folder of ready files instead", "refused");
          if (r && r.error) throw refuse(String(r.error.message || "the page could not be built"), String(r.error.code || "failed"));
          if (r && r.data && r.data.react) { files = r.data.files; built = ` ${r.data.notes.join("; ")}.`; }
        }
        const kb = Math.max(1, Math.round(site.bytes / 1024));
        const left = site.skipped.length ? `; left out: ${site.skipped.slice(0, 5).join(", ")}${site.skipped.length > 5 ? ` and ${site.skipped.length - 5} more` : ""}` : "";
        return { digest: files === site.files ? site.digest : digestOf(files), files, logs: `Read ${site.files.length} file${site.files.length === 1 ? "" : "s"} (${kb} KB) from ${site.name}${left}.${built}`, runtime: { kind: "static" } };
      },
    });
    return { async stop() {} };
  },
};
