// J0 from a screenshot alone, for a screen with no DOM to read (the iOS simulator): the page's
// words are read back from the picture (ocr.swift), then the same checks as j0.mjs.
//   node scripts/matrix/j0-screen.mjs --png shot.png --text ocr.txt --device ios-safari --out results
import fs from "node:fs";
import { recorder, fixtureHits } from "./lib/results.mjs";

const arg = name => { const i = process.argv.indexOf("--" + name); return i < 0 ? undefined : process.argv[i + 1]; };
const r = recorder(arg("out") || "results", "J0", arg("device") || "screen");
const png = arg("png"), text = fs.existsSync(arg("text") || "") ? fs.readFileSync(arg("text"), "utf8") : "";
r.step("screenshot", Boolean(png && fs.existsSync(png)), png && fs.existsSync(png) ? { shot: r.saveShot("setup", 1, fs.readFileSync(png)) } : { why: "no screenshot" });
r.step("page", /What should we call you|Set up Vyre/i.test(text), { why: `read ${text.split("\n").filter(Boolean).length} lines from the screen` });
const hits = fixtureHits(text);
r.step("no-fixture-names", hits.length === 0, hits.length ? { why: "shows " + hits.join(", ") } : {});
process.exit(r.failed ? 1 : 0);
