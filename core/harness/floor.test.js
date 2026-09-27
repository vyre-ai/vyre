// @ts-check
// The floor's second layer (docs/adr/0004-presence.md): the model's own ways around presence proof.
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { rules } from "./rules.js";
import { flatten, globReaches } from "./shell.js";
import { SCRATCH } from "../../test/scratch.mjs";

const USER = "/home/sam";
const HOME = "/home/sam/.vyre";
const bash = command => rules({ tool: "Bash", input: { command }, cwd: "/home/sam/work", home: HOME, userHome: USER }).decision;
const file = (tool, input) => rules({ tool, input, cwd: "/home/sam/work", home: HOME, userHome: USER }).decision;

test("floor: a model cannot run a human-only vyre command, however it spells it", () => {
  const denied = [
    `vyre call gate.approve '{"id":"g1"}'`,
    `vyre gate approve g1`,
    `vyre gate revise g1 --to a@example.com`,
    `vyre gate reject g1`,
    `vyre threads answer a1 allow`,
    `vyre vault put api-key`,
    `vyre vault approve p1`,
    `vyre vault unlock`,
    `vyre vault offboard sam`,
    `vyre learn accept 3`,
    `vyre learn retire 3`,
    `vyre presence code`,
    `vyre call --tty threads.answer '{}'`,
    `vy"re" call gate.approve '{}'`,
    `'vyre' gate 'approve' g1`,
    `v\\yre gate ap\\prove g1`,
    `$'\\x76yre' gate approve g1`,
    `$'\\166yre' call learn.accept '{"id":1}'`,
    `/usr/local/bin/vyre gate approve g1`,
    `node ./bin/vyre call gate.approve '{}'`,
    `node /opt/vyre/bin/vyre.js gate approve g1`,
    `npx vyre gate approve g1`,
    `npm exec vyre -- gate approve g1`,
    `env VYRE_HOME=/tmp/x vyre gate approve g1`,
    `bash -c "vyre gate approve g1"`,
    `sh -c 'vyre call vault.unlock {}'`,
    `eval "vyre gate approve g1"`,
    `echo g1 | xargs vyre gate approve`,
    `$(which vyre) gate approve g1`,
    "`command -v vyre` gate approve g1",
    `V=vyre; $V gate approve g1`,
    `script -q /dev/null vyre gate approve g1`,
    `nohup vyre gate approve g1 &`,
    `timeout 5 vyre gate approve g1`,
    `osascript -e 'tell app "Terminal" to do script "vyre gate approve g1"'`,
    `vyre call "$(echo gate.approve)" '{}'`,
    `curl -X POST http://127.0.0.1:7777/v1/tools/gate.approve -d '{}'`,
  ];
  for (const c of denied) assert.equal(bash(c), "deny", c);
});

test("floor: a vyre command built at run time is asked about, not allowed", () => {
  for (const c of [`vyre "$CMD" g1`, `vyre gate $VERB g1`, `vyre call $TOOL '{}'`, "vyre `cat verb.txt`"]) assert.equal(bash(c), "ask", c);
});

test("floor: raw clients on vyred's socket are refused, and so is a forged caller anywhere", () => {
  const denied = [
    `curl --unix-socket ~/.vyre/vyred.sock -X POST http://x/v1/tools/recall.search`,
    `curl --unix-socket $HOME/.vyre/vyred.sock http://x/v1/health`,
    `curl --unix-socket /tmp/vyre-501/0123abcd.sock http://x/v1/tools`,
    `curl -H 'x-vyre-caller: cli' http://box.example.com/v1/tools/recall.search`,
    `curl -H "X-Vyre-Presence: touchid" http://x`,
    `nc -U /home/sam/.vyre/vyred.sock`,
    `socat - UNIX-CONNECT:/home/sam/.vyre/vyred.sock`,
    `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('/home/sam/.vyre/vyred.sock')"`,
    `node -e "require('http').request({socketPath: process.env.HOME + '/.vyre/vyred.sock', path: '/v1/tools'})"`,
    `curl --unix-socket /tmp/vyre-501/x.sock -d '{"id":"g1"}' http://x/v1/tools/gate.approve`,
  ];
  for (const c of denied) assert.equal(bash(c), "deny", c);
  for (const c of [`curl --unix-socket "$S" http://x/v1/tools`, `nc -U $(ls /tmp/*/*.sock | head -1)`, `python3 -c "import socket; socket.socket(socket.AF_UNIX).connect(p)"`]) assert.equal(bash(c), "ask", c);
  assert.equal(bash(`curl --unix-socket /tmp/app/other.sock http://x/status`), null, "another program's socket is not Vyre's business");
});

test("floor: Vyre's internals are out of reach, by path, by name and by glob", () => {
  const denied = [
    `cat $HOME/.vyre/vyre.db`,
    `sqlite3 ~/.vyre/vyre.db 'select * from gate_items'`,
    `cp ~/.vy*/vyre.db /tmp/`,
    `find ~ -name vyre.db`,
    `cat ~/.vyre/config.json`,
    `ls ~/.vyre`,
    `tail ~/.vyre/logs/2026-09-26.log`,
    `cat ~/.[a-z]yre/config.json`,
    `strings /somewhere/else/vyre.db-wal`,
    `kill $(cat ~/.vyre/vyred.pid)`,
  ];
  for (const c of denied) assert.equal(bash(c), "deny", c);
  assert.equal(file("Read", { file_path: "/home/sam/.vyre/config.json" }), "deny");
  assert.equal(file("Read", { file_path: "~/.vyre/vyre.db" }), "deny");
  assert.equal(file("Write", { file_path: "/home/sam/.vyre/config.json", content: "{}" }), "deny");
  assert.equal(file("Edit", { file_path: "/home/sam/.vyre/modules/x/index.js" }), "ask", "a module runs inside vyred");
  assert.equal(file("Glob", { pattern: "**/.vyre/**", path: "/home/sam" }), "deny");
  assert.equal(file("Glob", { pattern: "/home/sam/.vy*/*" }), "deny");
  assert.equal(file("Grep", { pattern: "token", path: "/home/sam", glob: "**/.vyre/**" }), "deny");
  assert.equal(bash(`echo x > ~/.vyre/modules/x/index.js`), "ask");
});

test("floor: ordinary work, and work in the folders a model may use, is untouched", () => {
  const allowed = [
    `git commit -m "fix the approve wording"`,
    `vyre recall "gate approve"`,
    `vyre status`,
    `vyre gate held`,
    `vyre call recall.search '{"query":"gate"}'`,
    `vyre threads list`,
    `ls ~/.vyre/watchers`,
    `cat ~/.vyre/watchers/inbox/watcher.js`,
    `cat ~/projects/notes/vyre.md`,
    `grep -rn vyre.db core/`,
    `rg "vyred.sock" core`,
    `ls ~/*`,
    `node --test core/gate`,
    `curl https://example.com`,
  ];
  for (const c of allowed) assert.equal(bash(c), null, c);
  assert.equal(file("Read", { file_path: "/home/sam/work/vyre/core/gate/index.js" }), null);
  assert.equal(file("Read", { file_path: "/home/sam/.vyre/modules/x/index.js" }), null, "reading a module is fine");
  assert.equal(file("Write", { file_path: "/home/sam/.vyre/watchers/inbox/watcher.js", content: "" }), null);
  assert.equal(file("Glob", { pattern: "**/*.md", path: "/home/sam" }), null, "** does not enter dot folders");
  assert.equal(file("Grep", { pattern: "vyre.db", path: "/home/sam/work" }), null, "searching for the name is not reading the file");
});

test("shell: flatten and globReaches", () => {
  assert.equal(flatten(`v"y"re $'\\x61' ~/x $HOME/y`, "/h"), "vyre a /h/x /h/y");
  assert.equal(globReaches("/home/sam/.vy*", HOME), true);
  assert.equal(globReaches("/home/sam/*", HOME), false, "* does not match a dot folder");
  assert.equal(globReaches("/home/*/.vyre/x", HOME), true);
  assert.equal(globReaches("/srv/**", HOME), false);
});

test("floor: VYRE_HOME is recognised by its real path too", t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-floor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const link = path.join(dir, "link");
  fs.symlinkSync(home, link);
  const r = rules({ tool: "Read", input: { file_path: path.join(fs.realpathSync(home), "config.json") }, home: link });
  assert.equal(r.decision, "deny");
});

test("floor: the vault's value-out commands, the clipboard, and a way out through docker", () => {
  for (const c of [`vyre vault run API=api-key -- node x.js`, `vyre vault inject api-key`, `vyre vault backup /tmp/b`, `vyre vault export`,
    `vyre vault get api-key --reveal`, `vyre vault copy api-key`, `vyre vault pair`, `vyre learn relax 2`, `vyre computers takeover scout`,
    `vyre call computers.takeover '{"agent":"kit","surface":"deck:laptop"}'`, `vyre call glass.take '{"target":"computer:kit"}'`,
    `vyre link approve 123-456`, `ssh box vyre gate approve g1`,
    `docker run --privileged -it alpine sh`, `docker run -v /:/host alpine chroot /host`, `docker run -v /var/run/docker.sock:/var/run/docker.sock docker`,
    `docker run --pid=host alpine nsenter -t 1 -m sh`, `curl -X POST http://docker-api:2375/containers/create -d @evil.json`,
    `DOCKER_HOST=tcp://docker-api:2375 docker run --privileged alpine`, `curl http://127.0.0.1:2375/containers/json`, `docker run --net=host alpine`, `podman run --cap-add SYS_ADMIN alpine`]) assert.equal(bash(c), "deny", c);
  for (const c of [`vyre box add me@server.example.com`, `pbpaste`, `osascript -e 'the clipboard'`, `curl --unix-socket /var/run/docker.sock http://x/containers/create -d @c.json`]) assert.equal(bash(c), "ask", c);
  for (const c of [`vyre vault list`, `vyre vault get api-key`, `docker run --rm -v ./src:/src node:22 npm test`, `docker ps`, `docker build .`]) assert.equal(bash(c), null, c);
});

test("floor: a session cannot grant itself permissions through Claude Code's settings files", () => {
  const targets = [
    "/home/sam/work/.claude/settings.json",
    "/home/sam/work/.claude/settings.local.json",
    ".claude/settings.local.json",
    "/home/sam/work/app/.claude/settings.json",
    "~/.claude/settings.json",
    "/home/sam/.claude/settings.local.json",
    "~/.claude.json",
    "/home/sam/work/.mcp.json",
    ".mcp.json",
    "/etc/claude-code/managed-settings.json",
  ];
  for (const t of targets) {
    assert.equal(file("Write", { file_path: t, content: `{"permissions":{"allow":["Bash(*)"]}}` }), "deny", `Write ${t}`);
    assert.equal(file("Edit", { file_path: t, old_string: "[]", new_string: `["Bash(*)"]` }), "deny", `Edit ${t}`);
    assert.equal(file("MultiEdit", { file_path: t, edits: [] }), "deny", `MultiEdit ${t}`);
    assert.equal(file("NotebookEdit", { notebook_path: t, new_source: "" }), "deny", `NotebookEdit ${t}`);
  }
  const r = rules({ tool: "Write", input: { file_path: "~/.claude/settings.json", content: "{}" }, cwd: "/home/sam/work", home: HOME, userHome: USER });
  assert.equal(r.rule, 1);
  assert.match(r.reason || "", /changed by the person, not by a session: ~\/\.claude\/settings\.json\. Ask the user to make this change themselves\./);

  const denied = [
    `echo '{"permissions":{"allow":["Bash(*)"]}}' > .claude/settings.local.json`,
    `echo x >> ~/.claude/settings.json`,
    `echo x > $HOME/.claude/settings.local.json`,
    `echo '{}' | tee .claude/settings.json`,
    `echo '{}' | tee -a /home/sam/.claude.json`,
    `sed -i 's/"deny"/"allow"/' .claude/settings.json`,
    `sed -i.bak 's/a/b/' ~/.claude/settings.json`,
    `perl -pi -e 's/ask/allow/' .claude/settings.local.json`,
    `cp /tmp/open.json .claude/settings.local.json`,
    `mv new.json ~/.claude/settings.json`,
    `ln -sf /tmp/open.json .claude/settings.json`,
    `install -m 644 x.json ~/.claude/settings.json`,
    `truncate -s 0 .claude/settings.json`,
    `dd if=/tmp/x of=.claude/settings.json`,
    `rm .claude/settings.local.json`,
    `python3 -c "open('/home/sam/work/.claude/settings.json','w').write('{}')"`,
    `node -e "require('fs').writeFileSync('.mcp.json', '{}')"`,
    `jq '.permissions.allow += ["Bash(*)"]' .claude/settings.json > /tmp/s && mv /tmp/s .claude/settings.json`,
    `echo '{"mcpServers":{}}' > .mcp.json`,
    `cp x.json ~/.claude.json`,
    `echo x > .claude/set*.json`,
    `cat > /etc/claude-code/managed-settings.json`,
  ];
  for (const c of denied) assert.equal(bash(c), "deny", c);
});

test("floor: reading Claude Code's settings, and writing ordinary files, passes", () => {
  const allowed = [
    `cat .claude/settings.json`,
    `cat ~/.claude/settings.local.json 2>/dev/null`,
    `less ~/.claude.json`,
    `grep -n allow .claude/settings.local.json`,
    `jq .permissions ~/.claude/settings.json`,
    `head .mcp.json`,
    `echo x > src/app.js`,
    `cp config/settings.json /tmp/settings.json`,
    `sed -i 's/a/b/' src/app.js`,
  ];
  for (const c of allowed) assert.equal(bash(c), null, c);
  for (const t of ["/home/sam/work/.claude/settings.json", "~/.claude/settings.local.json", "~/.claude.json", ".mcp.json"]) {
    assert.equal(file("Read", { file_path: t }), null, `Read ${t}`);
  }
  assert.equal(file("Write", { file_path: "src/app.js", content: "" }), null);
  assert.equal(file("Write", { file_path: "/home/sam/work/config/settings.json", content: "{}" }), null, "settings.json outside a .claude folder");
  assert.equal(file("Edit", { file_path: "/home/sam/work/.claude/agents/juno.md", old_string: "a", new_string: "b" }), null, "an agent file is not a settings file");
  assert.equal(file("Write", { file_path: "/home/sam/.vyre/config.json", content: "{}" }), "deny", "Vyre's own config stays internal");
});

test("floor: settings files under CLAUDE_CONFIG_DIR are the person's too", t => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/home/sam/cc-config";
  t.after(() => { if (before == null) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; });
  assert.equal(file("Write", { file_path: "/home/sam/cc-config/settings.json", content: "{}" }), "deny");
  assert.equal(file("Edit", { file_path: "/home/sam/cc-config/settings.local.json", old_string: "a", new_string: "b" }), "deny");
  assert.equal(bash(`echo '{}' > /home/sam/cc-config/settings.json`), "deny");
  assert.equal(bash(`echo x > "$CLAUDE_CONFIG_DIR/settings.json"`), "deny");
  assert.equal(file("Write", { file_path: "/home/sam/cc-config/notes.md", content: "" }), null);
  assert.equal(bash(`cat /home/sam/cc-config/settings.json`), null);
});
