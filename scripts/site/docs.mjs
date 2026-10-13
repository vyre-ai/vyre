// @ts-check
// The docs on vyre.run: what scripts/build-docs --mount-site adds to the docs/ tree to publish it at https://vyre.run/docs/.
//
// docs/ publishes as it is (nav.json decides). These files live outside docs/ and join it, each with its raw Markdown beside it:
//   ARCHITECTURE.md          /docs/project/ARCHITECTURE        and /docs/project/ARCHITECTURE.md
//   DEVELOPMENT-RULES.md     /docs/project/DEVELOPMENT-RULES   and .md
//   roadmap/*.md             /docs/roadmap/<name>              and .md   (roadmap/README.md is /docs/roadmap/README)
// They sit under project/ because /docs/architecture/ is the architecture section and Pages paths are not safe to tell apart by case.

import fs from "node:fs";
import path from "node:path";

export const MOUNT = "/docs";
export const ORIGIN = "https://vyre.run";

/** The links at the top of every docs page and of the phone sidebar: the rest of vyre.run. */
export const TOP_LINKS = /** @type {[string, string][]} */ ([
  ["Home", "/"],
  ["Architecture", "/architecture/"],
  ["Direction", "/direction/"],
  ["Get started", "/start/"],
]);

/** @param {string} root the repo root */
export function extras(root) {
  const list = [
    { src: "ARCHITECTURE.md", path: "project/ARCHITECTURE.md", section: "Project", title: "Architecture: the front door",
      summary: "How Vyre is built on one page: what it is, the layers, and a table of contents into every architecture page." },
    { src: "DEVELOPMENT-RULES.md", path: "project/DEVELOPMENT-RULES.md", section: "Project", title: "Development rules",
      summary: "The rules every change to Vyre follows: how it is built, tested, reviewed and released." },
  ];
  const dir = path.join(root, "roadmap");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".md")).sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a < b ? -1 : 1))) {
      const readme = f === "README.md";
      list.push({
        src: `roadmap/${f}`, path: `roadmap/${f}`, section: "Roadmap plans",
        title: readme ? "Roadmap by version" : `Plan for ${f.replace(/\.md$/, "")}`,
        summary: readme ? "How each planned version gets its branch and its plan." : `What version ${f.replace(/\.md$/, "")} sets out to do, with the acceptance test for each item.`,
      });
    }
  }
  return list;
}

/** The options build() takes to mount the docs under vyre.run. @param {string} root */
export function mountOptions(root) {
  return { base: MOUNT, origin: ORIGIN, extras: extras(root), topLinks: TOP_LINKS };
}

/** Every docs page's path on vyre.run, in nav order, for sitemap.xml. @param {string} root */
export async function docsPaths(root) {
  const { loadDocs } = await import("../lib/docs/load.js");
  const enc = (/** @type {string} */ p) => p.split("/").map(encodeURIComponent).join("/");
  return loadDocs(root, { extras: extras(root) }).map(p => MOUNT + enc(p.url));
}

/** The "Docs" part of llms.txt and llms-full.txt: where the docs are and the pages an agent reads first. Raw Markdown beside every page. */
export function llmsDocs(site = ORIGIN) {
  const d = `${site}${MOUNT}`;
  return `## Docs
- [Docs home](${d}/): every guide, reference page and architecture page, in the same design as this site
- [docs/llms.txt](${d}/llms.txt): every docs page as a link to its Markdown; ${d}/llms-full.txt has them all in one file
- [index.json](${d}/index.json): every command, tool, event, config key and concept, with the page that explains it
- [Architecture, the front door](${d}/project/ARCHITECTURE.md): how Vyre is built, with a table of contents into every architecture page
- [Map your business onto Vyre](${d}/for-agents/MAP-YOUR-BUSINESS.md): the method an AI agent follows to turn a business into members, records, Flows, agents and Gate rules
- [Development rules](${d}/project/DEVELOPMENT-RULES.md): the rules every change follows
- [Roadmap](${d}/roadmap.md) and [plans by version](${d}/roadmap/README.md)
- Every docs page is also its raw Markdown at the same path with .md, for example ${d}/architecture/overview.md
`;
}
