// @ts-check
// .github/workflows/site-deploy.yml (#16): vyre.run follows a stable release, behind the deploy environment's reviewer, and is checked afterwards.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yml = fs.readFileSync(path.join(REPO, ".github/workflows/site-deploy.yml"), "utf8");

test("site-deploy: runs after the release workflow, and by hand with a tag, from main only", () => {
  assert.match(yml, /workflow_run:\n\s+workflows: \[release\]\n\s+types: \[completed\]/);
  assert.match(yml, /workflow_dispatch:\n\s+inputs:\n\s+tag:/);
  assert.equal((yml.match(/\[ "\$REF" = refs\/heads\/main \]/g) || []).length, 2, "both jobs refuse any ref but main");
});

test("site-deploy: only a published stable release is deployed, and the deploy waits for the deploy environment", () => {
  assert.match(yml, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/, "a vX.Y.Z tag, no prerelease suffix");
  assert.match(yml, /isPrerelease,isDraft/);
  assert.match(yml, /environment: deploy/);
  assert.match(yml, /needs: assemble/);
  assert.equal((yml.match(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/g) || []).length, 1, "the token is in one step, the deploy, and in the deploy environment only");
  assert.doesNotMatch(yml.split("deploy:\n    name:")[0], /secrets\./, "the assemble job has no secrets");
});

test("site-deploy: assembles from the tag, deploys with the production refusals, and checks the served copy", () => {
  assert.match(yml, /scripts\/assemble-site\.sh --out "\$RUNNER_TEMP\/site" --tag "\$TAG"/);
  assert.match(yml, /scripts\/deploy-site\.sh "\$RUNNER_TEMP\/site" --branch main/);
  assert.match(yml, /--check https:\/\/vyre\.run/);
});

test("site-deploy: every action is pinned by commit sha", () => {
  for (const m of yml.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
});

const assemble = fs.readFileSync(path.join(REPO, "scripts/assemble-site.sh"), "utf8");

test("assemble-site: an over-limit vyre.tgz is redirected to the tag's release, every other needed file still refuses", () => {
  assert.match(assemble, /basename "\$f"\)" = vyre\.tgz \]; then mv "\$f" "\$big\/vyre\.tgz"; tgz_redirect=1/, "vyre.tgz is set aside, not copied");
  assert.match(assemble, /\/box\/vyre\.tgz https:\/\/github\.com\/vyre-ai\/vyre\/releases\/download\/%s\/vyre\.tgz 302/, "the 302 goes to the tag's own release asset");
  const needed = (assemble.match(/case " (VERSION [^"]*) " in/) || [])[1] || "";
  assert.doesNotMatch(needed, /vyre\.tgz/, "vyre.tgz is no longer on the refuse list");
  for (const f of ["VERSION", "SHA256SUMS", "SHA256SUMS.sig", "manifest.json", "release.json", "vyre", "compose.yml", "install-box.sh", "install-mac-server.sh"]) assert.ok(needed.split(" ").includes(f), `${f} still refuses when over the limit`);
  assert.match(assemble, /sum -c --quiet SHA256SUMS\) \|\| \{ echo "assemble-site: the release files do not match/, "the release's checksums are verified before the file is set aside");
  assert.match(assemble, /want="\$big\/vyre\.tgz"/, "--check compares the redirected bytes with the release's copy");
});

test("install-box and the box wrapper follow a redirect when they fetch vyre.tgz", () => {
  for (const f of ["scripts/install-box.sh", "box/vyre"]) {
    const src = fs.readFileSync(path.join(REPO, f), "utf8");
    assert.match(src, /curl -fsSL "\$/, `${f}: curl -L follows the redirect`);
    assert.match(src, /wget -qO "/, `${f}: wget follows redirects by default`);
    assert.doesNotMatch(src, /--max-redirect[= ]0|--no-location/, `${f}: nothing turns redirects off`);
  }
});

test("assemble-site --check: only our own email_off comments are removed from the assembled page before the comparison", () => {
  assert.match(assemble, /\*\.html\) sed -f "\$here\/scripts\/strip-email-off\.sed" "\$want"/, "an HTML page is compared with the stripped assembled copy");
  const sedFile = path.join(REPO, "scripts/strip-email-off.sed");
  const run = (/** @type {string} */ input) => spawnSync("sed", ["-f", sedFile], { input, encoding: "utf8" }).stdout;
  assert.equal(run('<p><!--email_off--><code>alex@192.0.2.10</code><!--/email_off--> and <!--email_off--><a href="mailto:a@b.example">a@b.example</a><!--/email_off--></p>\n'), '<p><code>alex@192.0.2.10</code> and <a href="mailto:a@b.example">a@b.example</a></p>\n');
  const other = "<!-- a different comment --><!--email_off ---><p>x</p>\n";
  assert.equal(run(other), other, "any other comment is left alone, so a real difference still shows");
});
