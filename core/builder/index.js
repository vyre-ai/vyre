// @ts-check
// builder: answers Publish's `builder.build`. Today it reads a folder of ready files (lib/publish/folder-build.js) and runs nothing; a repo, a Drive folder or a build command is refused in plain words
// that name what is missing, never silently skipped. The container builder (BuildKit, core/publish/builder-plan.js) answers the same tool when it exists.

import { readSite, digestOf } from "../../lib/publish/folder-build.js";
import { checkDockerfile, buildImage } from "./container.js";

/** Test seam: a stand-in for the image build (the real one needs Docker). */
export const seam = /** @type {{ buildImage: null | typeof buildImage }} */ ({ buildImage: null });

const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const NEEDS_CONTAINER = "this server builds a folder of ready files; a repo, a Drive folder or a build command needs the container builder, which is not installed here yet";

/** What a deployment asks of a build, and the plain refusal when it is more than this builder does. @param {any} d @returns {{ dir: string, outputDir: string, dockerfile: boolean }} */
export function planOf(d) {
  const src = (d && d.source) || {}, b = (d && d.build) || {};
  if (src.kind !== "folder") throw refuse(NEEDS_CONTAINER, "refused");
  if (b.command) throw refuse(`a build command (${String(b.command).slice(0, 40)}) needs the container builder, which is not installed here yet; publish a folder of ready files instead`, "refused");
  if (b.image && b.image !== "static" && b.image !== "dockerfile") throw refuse(`the ${b.image} image needs the container builder, which is not installed here yet`, "refused");
  return { dir: String(src.ref || ""), outputDir: String(b.output_dir || "."), dockerfile: b.image === "dockerfile" };
}

/** The health a published server is held to unless it names its own: any answer that means the server is up. */
export const HEALTH = Object.freeze({ path: "/", ok: Object.freeze([200, 301, 302, 401, 403, 404]) });

/**
 * A folder with a Dockerfile, built into an image (team/contracts/builder.md, the container path). The folder is read exactly as the static path reads it, so an .env, a key and .git are not in the
 * build context and the same folder is the same version.
 * @param {any} ctx @param {any} d @param {string} dir @param {string[]} secretArgs
 */
async function containerBuild(ctx, d, dir, secretArgs) {
  let site;
  try { site = readSite({ dir, outputDir: "." }); } catch (/** @type {any} */ e) { throw refuse(e && e.message ? String(e.message) : "the folder could not be read", e && e.code ? String(e.code) : "failed"); }
  const df = site.files.find((/** @type {any} */ f) => f.path === "Dockerfile");
  if (!df) throw refuse("the folder has no Dockerfile at its top; add one, or publish a folder of ready files", "refused");
  const allow = (ctx.config && ctx.config.builder && Array.isArray(ctx.config.builder.from) ? ctx.config.builder.from : []).filter((/** @type {any} */ x) => typeof x === "string");
  const checked = checkDockerfile(df.content.toString("utf8"), { allow });
  const port = d.build && Number.isInteger(d.build.port) ? d.build.port : checked.port;
  if (!port) throw refuse("name the port the app listens on: set the build's port, or put an EXPOSE line in the Dockerfile", "refused");
  const tag = `vyre-pub-${String(d.name || "app").replace(/[^a-z0-9-]/g, "")}:${site.digest.replace(/^sha256:/, "").slice(0, 16)}`;
  const built = await (seam.buildImage || buildImage)({ files: site.files, tag, secretArgs });
  const left = site.skipped.length ? `; left out: ${site.skipped.slice(0, 5).join(", ")}${site.skipped.length > 5 ? ` and ${site.skipped.length - 5} more` : ""}` : "";
  return { digest: site.digest, files: [], logs: `Built an image from ${site.files.length} file${site.files.length === 1 ? "" : "s"} of ${site.name}${left}.\n${built.logs}`, runtime: { kind: "image", image: built.image, port, health: { path: HEALTH.path, ok: [...HEALTH.ok] } } };
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
        const { dir, outputDir, dockerfile } = planOf(i.deployment);
        if (dockerfile) return containerBuild(ctx, i.deployment, dir, i.secretArgs || []);
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
