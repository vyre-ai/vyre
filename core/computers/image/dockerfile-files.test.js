// @ts-check
// The image can only run what its Dockerfile copies. A file agentd imports or starts that the COPY line does not name makes agentd fail on its first import inside the image, which no unit test sees (they run from
// the repository). This reads the Dockerfile's COPY list into /opt/agentd and fails when an import, a spawn target (/opt/agentd/<file>), or a file of this folder that belongs in the image is missing from it.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const dockerfile = fs.readFileSync(path.join(DIR, "Dockerfile"), "utf8").replace(/\\\n\s*/g, " ");
/** the files COPYd to /opt/agentd/ */
const copied = new Set(/** @type {string[]} */ ([]));
for (const line of dockerfile.split("\n")) {
  const m = /^COPY\s+(.+?)\s+(\S+)\s*$/.exec(line.trim());
  if (m && m[2] === "/opt/agentd/") for (const f of m[1].split(/\s+/)) copied.add(f);
}
const GENERATED = new Set(["package.json", "client"]);   // written by a RUN line
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(DIR, f), "utf8");
const shippable = fs.readdirSync(DIR).filter(f => /^agentd[a-z-]*\.(js|py)$/.test(f) && !/\.test\./.test(f));

test("the Dockerfile copies the files of this folder that belong in the image, and nothing it names is missing from the folder", () => {
  assert.ok(copied.size >= 5, "the COPY list into /opt/agentd/ was found");
  for (const f of shippable) assert.ok(copied.has(f), `${f} is in this folder but not in the Dockerfile's COPY list`);
  for (const f of copied) assert.ok(fs.existsSync(path.join(DIR, f)), `${f} is in the COPY list but not in this folder`);
});

test("every relative import of a copied file, and every /opt/agentd/<file> any file here starts or imports, is a copied file", () => {
  const files = [...copied, "entrypoint.sh", "Dockerfile"];
  for (const f of files) {
    const text = f === "Dockerfile" ? dockerfile : read(f);
    if (/\.js$/.test(f)) {
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)["']\.\/([A-Za-z0-9._-]+)["']/g)) assert.ok(copied.has(m[1]), `${f} imports ./${m[1]}, which is not copied into /opt/agentd`);
    }
    for (const m of text.matchAll(/\/opt\/agentd\/([A-Za-z0-9._-]+)/g)) {
      const name = m[1].replace(/\.$/, "");
      if (GENERATED.has(name) || name === "*.js") continue;
      assert.ok(copied.has(name), `${f} names /opt/agentd/${name}, which is not copied`);
    }
  }
});

test("the desk: the wallpaper's mark is the app's Vyre mark as given, the window manager's files start nothing, and the image copies both where agentd.js looks", async () => {
  const { DESK } = await import("./agentd.js");
  const mark = fs.readFileSync(path.join(DIR, "desk", "mark.png")), icon = fs.readFileSync(path.join(DIR, "../../../site/icon-192.png"));
  assert.ok(mark.equals(icon), "desk/mark.png is a copy of site/icon-192.png (the mark the site and the app use): copy it again when the mark changes");
  assert.match(dockerfile, /^COPY desk\/fluxbox \/etc\/vyre-desk\/fluxbox$/m);
  assert.match(dockerfile, /^COPY desk\/mark\.png \/usr\/share\/vyre-desk\/mark\.png$/m);
  assert.equal(DESK.fluxbox, "/etc/vyre-desk/fluxbox/init");
  assert.equal(DESK.mark, "/usr/share/vyre-desk/mark.png");
  const init = read("desk/fluxbox/init");
  for (const f of ["menu", "keys", "apps", "overlay", "windowmenu"]) {
    assert.match(init, new RegExp(`:\\t/etc/vyre-desk/fluxbox/${f}$`, "m"), `init names /etc/vyre-desk/fluxbox/${f}`);
    assert.ok(fs.existsSync(path.join(DIR, "desk", "fluxbox", f)), `desk/fluxbox/${f} is there`);
  }
  assert.match(init, /^session\.screen0\.toolbar\.visible:\tfalse$/m, "no toolbar");
  // fluxbox runs as the screen's owner (the browser uid): nothing it offers may start a program, and the desktop has no menu
  const keys = read("desk/fluxbox/keys"), menu = read("desk/fluxbox/menu"), wmenu = read("desk/fluxbox/windowmenu");
  assert.doesNotMatch(keys, /\b(Exec|ExecCommand|RootMenu|Restart|Reconfigure|CommandDialog)\b/i, "no key starts a program or opens the desktop menu");
  assert.doesNotMatch(menu + wmenu, /\[(exec|submenu|include|config|stylesdir|workspaces|restart|exit|wallpapers)\]/i, "the menus start nothing");
  assert.doesNotMatch(wmenu, /\[iconify\]/, "nothing can be minimized to a toolbar that is not there");
  assert.match(read("desk/fluxbox/overlay"), /^background: none$/m, "fluxbox sets no wallpaper of its own");
});

test("the dock runs only as an agent's uid, builds its own environment, starts no shell, and reaches Chrome only through the holder's FIFO", () => {
  const dock = read("agentd-dock.py"), holder = read("agentd-chrome.py");
  assert.match(dock, /uid < 20000 or uid > 20063 or uid != os\.getuid\(\) or len\(sys\.argv\) != 1/);
  assert.doesNotMatch(dock, /os\.environ|getenv|shell=True|os\.system|cdp\.sock|browsers\//, "nothing from its environment, no shell, nothing of the browser uid's");
  assert.match(dock, /HOME = "\/var\/lib\/vyre\/agents\/%s\/home" % USER/);
  assert.match(dock, /SHOW = "\/var\/lib\/vyre\/x\/%s\/show-chrome" % USER/);
  assert.match(holder, /SHOW = "\/var\/lib\/vyre\/x\/ag%d\/show-chrome" % N/, "the holder makes the same FIFO, in the folder only the browser uid may write");
  assert.match(holder, /os\.chmod\(SHOW, 0o620\)/, "the agent's group may write it and nobody else may read it");
  assert.match(holder, /os\.read\(show, 4096\)\s+# what was written is never looked at/);
  assert.match(holder, /if show_due and since_nul == 0:/, "the tab request goes between two of the client's messages, never inside one");
});

test("the chmod line makes every copied python helper readable (root-owned, run by name)", () => {
  const chmod = /chmod 0644 (.*\/opt\/agentd\/package\.json)/.exec(dockerfile);
  assert.ok(chmod, "a chmod 0644 line");
  for (const f of copied) if (f.endsWith(".py")) assert.ok(chmod[1].includes(`/opt/agentd/${f}`), `${f} is not made readable`);
});

test("a copied file that imports a file of a subfolder (agentd-fs.js and computerd's file routes) finds it copied to the same place, root's and readable", () => {
  for (const f of copied) {
    if (!/\.js$/.test(f)) continue;
    for (const m of read(f).matchAll(/(?:from\s+|import\s*\(\s*)["']\.\/([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)["']/g)) {
      assert.match(dockerfile, new RegExp(`^COPY ${m[1].replace(/[.]/g, "\\.")} /opt/agentd/${m[1].replace(/[.]/g, "\\.")}$`, "m"), `${f} imports ./${m[1]}, which is not copied to /opt/agentd/${m[1]}`);
      assert.ok(fs.existsSync(path.join(DIR, m[1])), `${m[1]} is in this folder`);
      assert.match(dockerfile, new RegExp(`chmod 0644 [^\\n]*/opt/agentd/${m[1].replace(/[.]/g, "\\.")}`), `${m[1]} is made readable`);
    }
  }
  assert.match(read("agentd-fs.js"), /from "\.\/computerd\/fs\.js"/, "the file helper uses computerd's own routes");
});
