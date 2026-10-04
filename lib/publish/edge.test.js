// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { edgeCompose, caddyfile, caddyDockerfile, IMAGES, assertIsolated, isolationProblems, composeText, previewHost, defaultHost, validateWorkload, REGISTRIES } from "./edge.js";
import { SPACE } from "./test-kit.js";

const IMG = "vyre-publish/app@sha256:" + "d".repeat(64);
const A = "dep_0123456789abcdef", B = "dep_fedcba9876543210";
const sample = () => edgeCompose(SPACE, [
  { id: A, kind: "static", name: "northwind", stage: "Production" },
  { id: B, kind: "node", image: IMG, port: 3000, env: { NODE_ENV: "production" }, secrets: ["STRIPE_KEY"], name: "kit", stage: "Preview" },
]);
const clone = (/** @type {any} */ o) => JSON.parse(JSON.stringify(o));
const throwsCode = (/** @type {() => any} */ fn, /** @type {string} */ code) => assert.throws(fn, (/** @type {any} */ e) => e.code === code, code);

test("compose project: caddy public, buildkit private, one service per workload, own networks", () => {
  const c = sample();
  assert.equal(c.name, "vyre-publish-spc_a1b2c3d4e5f6");
  assert.deepEqual(Object.keys(c.services).sort(), ["buildkit", "caddy", `w-${A.slice(4)}`, `w-${B.slice(4)}`].sort());
  assert.deepEqual(c.services.caddy.ports, ["80:80", "443:443", "443:443/udp"]);
  assert.equal(c.services.buildkit.ports, undefined);
  assert.deepEqual(c.services.buildkit.networks, ["build", "build_egress"]);
  assert.equal(c.networks.build.internal, true);
  assert.equal(c.networks[`wl-${A.slice(4)}`].internal, true);
  assert.deepEqual(c.services[`w-${B.slice(4)}`].networks, [`wl-${B.slice(4)}`], "no outbound network for a site yet");
  assert.ok(c.services.caddy.networks.includes(`wl-${A.slice(4)}`));
  assert.ok(!c.services.caddy.networks.includes("build"));
  assert.equal(c.networks.build_egress.labels["vyre.publish.egress-allow"], REGISTRIES.join(","));
  assert.equal(assertIsolated(c), true);
  assert.deepEqual(isolationProblems(c), []);
  assert.equal(JSON.parse(composeText(c)).name, c.name);
});

test("every service is hardened: no caps, no new privileges, read-only root, limits, not root", () => {
  const c = sample();
  for (const [name, s] of Object.entries(c.services)) {
    assert.deepEqual(s.cap_drop, ["ALL"], name);
    assert.equal(s.cap_add, undefined, name);
    assert.ok(s.security_opt.includes("no-new-privileges:true"), name);
    assert.equal(s.read_only, true, name);
    assert.ok(s.mem_limit && s.cpus && s.pids_limit, name);
    assert.ok(!String(s.user || "").startsWith("0"), name);
    assert.equal(s.privileged, undefined);
    assert.equal(s.network_mode, undefined);
    assert.equal(s.pid, undefined);
  }
});

test("no docker socket, no bind mounts, no host paths, no shared volumes, no env from the space", () => {
  const c = sample();
  const text = JSON.stringify(c);
  for (const bad of ["docker.sock", "/var/run", "/srv/vyre", "/.vyre", "host.docker.internal"]) assert.ok(!text.includes(bad), bad);
  for (const s of Object.values(c.services)) for (const v of s.volumes || []) assert.match(v.split(":")[0], /^(caddy-data|caddy-config|buildkit-state|site-[0-9a-f]{16})$/);
  const users = {};
  for (const [n, s] of Object.entries(c.services)) for (const v of s.volumes || []) (users[v.split(":")[0]] ||= []).push(n);
  assert.ok(Object.values(users).every(u => u.length === 1));
  assert.equal(c.services.caddy.environment, undefined);
  assert.equal(c.services.buildkit.environment, undefined);
  assert.deepEqual(c.services[`w-${B.slice(4)}`].environment, { NODE_ENV: "production", STRIPE_KEY_FILE: "/run/secrets/STRIPE_KEY" });
  assert.ok(Object.values(c.networks).every(n => !n.external && n.driver === "bridge"));
  assert.ok(Object.values(c.volumes).every(v => !v.external && !v.driver_opts));
});

test("secrets are per deployment: only the owning workload mounts them", () => {
  const c = sample();
  const key = `${B.slice(4)}_STRIPE_KEY`;
  assert.equal(c.secrets[key].file, `./secrets/${B}/STRIPE_KEY`);
  assert.deepEqual(c.services[`w-${B.slice(4)}`].secrets, [{ source: key, target: "STRIPE_KEY" }]);
  assert.equal(c.services[`w-${A.slice(4)}`].secrets, undefined);
  assert.equal(c.services.caddy.secrets, undefined);
  // another workload trying to mount B's secret is caught
  const bad = clone(c);
  bad.services[`w-${A.slice(4)}`].secrets = [{ source: key, target: "STRIPE_KEY" }];
  assert.ok(isolationProblems(bad).some(p => /not granted to this deployment/.test(p)));
});

test("adversarial workloads: a mount, a privileged flag, a socket, host network, caps, an env named like a space secret", () => {
  const ok = { id: A, kind: "static" };
  const asks = [
    { volumes: ["/srv/vyre:/data"] }, { volumes: ["/var/run/docker.sock:/var/run/docker.sock"] }, { mounts: [{ type: "bind", source: "/", target: "/host" }] },
    { privileged: true }, { network_mode: "host" }, { cap_add: ["SYS_ADMIN"] }, { devices: ["/dev/kvm"] }, { pid: "host" }, { ports: ["22:22"] },
    { security_opt: ["seccomp=unconfined"] }, { user: "0" }, { read_only: false }, { networks: ["vyre"] }, { sysctls: { "net.ipv4.ip_forward": 1 } }, { extra: 1 },
  ];
  for (const a of asks) throwsCode(() => edgeCompose(SPACE, [{ ...ok, ...a }]), "isolation");
  for (const env of [{ VYRE_TOKEN: "x" }, { DATABASE_URL: "x" }, { POSTGRES_PASSWORD: "x" }, { TWENTY_API_KEY: "x" }, { DOCKER_HOST: "x" }, { TS_AUTHKEY: "x" }, { MY_API_KEY: "x" }, { SESSION_TOKEN: "x" }, { WINK_KEY: "x" }])
    throwsCode(() => edgeCompose(SPACE, [{ id: B, kind: "node", image: IMG, port: 3000, env }]), "isolation");
  throwsCode(() => edgeCompose(SPACE, [{ id: B, kind: "node", image: IMG, port: 3000, env: { OK: "vault://harlow/stripe" } }]), "isolation");
  throwsCode(() => edgeCompose(SPACE, [{ id: B, kind: "node", image: IMG, port: 3000, secrets: ["VYRE_KEY"] }]), "isolation");
  throwsCode(() => edgeCompose(SPACE, [{ id: B, kind: "node", image: "docker:dind", port: 3000 }]), "bad_input");
  throwsCode(() => edgeCompose(SPACE, [{ id: B, kind: "node", image: "../../etc/passwd:x", port: 3000 }]), "bad_input");
  throwsCode(() => edgeCompose(SPACE, [{ id: B, kind: "node", image: IMG, port: 22 }]), "bad_input");
  throwsCode(() => edgeCompose(SPACE, [{ id: "dep_x; rm", kind: "static" }]), "bad_input");
  throwsCode(() => edgeCompose(SPACE, [ok, ok]), "duplicate");
  throwsCode(() => edgeCompose({ id: "spc_x/../y", name: "harlow.vyre.run" }, []), "bad_input");
  throwsCode(() => validateWorkload(null), "bad_input");
});

test("resource limits are clamped, never raised past the cap", () => {
  const c = edgeCompose(SPACE, [{ id: A, kind: "static", limits: { mem: "9999m", cpus: 64, pids: 100000 } }]);
  const s = c.services[`w-${A.slice(4)}`];
  assert.deepEqual([s.mem_limit, s.cpus, s.pids_limit], ["256m", 0.5, 128]);
  const c2 = edgeCompose(SPACE, [{ id: A, kind: "static", limits: { mem: "512m", cpus: 1, pids: 200 } }]);
  assert.deepEqual([c2.services[`w-${A.slice(4)}`].mem_limit, c2.services[`w-${A.slice(4)}`].cpus], ["512m", 1]);
});

test("assertIsolated catches each invariant on hand-edited compose objects", () => {
  /** @type {Array<[string, (c: any) => void]>} */
  const cases = [
    ["privileged key", c => { c.services.caddy.privileged = true; }],
    ["host network", c => { c.services.caddy.network_mode = "host"; }],
    ["docker socket bind", c => { c.services.caddy.volumes.push("/var/run/docker.sock:/var/run/docker.sock"); }],
    ["bind of a space path", c => { c.services.caddy.volumes.push("/srv/vyre/data:/data2"); }],
    ["relative bind", c => { c.services.caddy.volumes.push("./home:/home"); }],
    ["object bind", c => { c.services.caddy.volumes.push({ type: "bind", source: "/", target: "/x" }); }],
    ["external volume", c => { c.volumes["caddy-data"] = { external: true }; }],
    ["bind in disguise", c => { c.volumes["caddy-data"] = { driver: "local", driver_opts: { type: "none", o: "bind", device: "/srv" } }; }],
    ["volume shared with another service", c => { c.services.buildkit.volumes.push("caddy-data:/x"); }],
    ["external network", c => { c.networks.edge = { external: true, name: "vyre_default" }; }],
    ["control network", c => { c.networks.control = { driver: "bridge" }; c.services.caddy.networks.push("control"); }],
    ["host driver", c => { c.networks.edge = { driver: "host" }; }],
    ["buildkit published", c => { c.services.buildkit.ports = ["1234:1234"]; }],
    ["buildkit on edge", c => { c.services.buildkit.networks.push("edge"); }],
    ["caddy on build", c => { c.services.caddy.networks.push("build"); }],
    ["build not internal", c => { c.networks.build.internal = false; }],
    ["workload on a shared network", c => { const w = Object.keys(c.services).find(n => n.startsWith("w-")); c.services[w].networks.push("build"); }],
    ["cap_add", c => { c.services.caddy.cap_add = ["NET_ADMIN"]; }],
    ["cap_drop missing", c => { c.services.caddy.cap_drop = []; }],
    ["new privileges allowed", c => { c.services.caddy.security_opt = []; }],
    ["unconfined", c => { c.services.buildkit.security_opt.push("seccomp=unconfined"); }],
    ["writable root", c => { c.services.caddy.read_only = false; }],
    ["no limits", c => { delete c.services.caddy.mem_limit; }],
    ["root user", c => { c.services.caddy.user = "0:0"; }],
    ["space env", c => { const w = Object.keys(c.services).find(n => n.startsWith("w-")); c.services[w].environment = { VYRE_HOME: "x" }; }],
    ["env on caddy", c => { c.services.caddy.environment = { A: "b" }; }],
    ["secret ref in env", c => { const w = Object.keys(c.services).find(n => n.startsWith("w-")); c.services[w].environment = { A: "vault://a/b" }; }],
    ["secret from a host file", c => { c.secrets = { x: { file: "/etc/shadow" } }; }],
    ["unknown service key", c => { c.services.caddy.devices = ["/dev/kvm"]; }],
    ["unknown top key", c => { c["x-anything"] = 1; }],
    ["bad project name", c => { c.name = "vyre"; }],
    ["missing buildkit", c => { delete c.services.buildkit; }],
    ["tmpfs outside /tmp", c => { c.services.caddy.tmpfs.push("/etc:rw"); }],
    ["sysctl", c => { c.services.caddy.sysctls["net.ipv4.ip_forward"] = 1; }],
    ["docker socket in a command", c => { c.services.caddy.command = ["sh", "-c", "cat /var/run/docker.sock"]; }],
  ];
  for (const [name, mutate] of cases) {
    const c = clone(sample());
    mutate(c);
    assert.ok(isolationProblems(c).length > 0, name);
    throwsCode(() => assertIsolated(c), "isolation");
  }
  throwsCode(() => assertIsolated(null), "isolation");
});

test("preview and default hosts", () => {
  assert.equal(previewHost(A, "harlow.vyre.run"), "0123456789abcdef.preview.harlow.vyre.run");
  assert.equal(defaultHost("northwind", "harlow.vyre.run"), "northwind.harlow.vyre.run");
  throwsCode(() => previewHost("dep_x", "harlow.vyre.run"), "bad_input");
  throwsCode(() => defaultHost("Bad Name", "harlow.vyre.run"), "bad_input");
  throwsCode(() => defaultHost("ok", "harlow.vyre.run\nevil"), "bad_domain");
});

const W = [{ id: A, kind: "static", name: "northwind", stage: "Production" }, { id: B, kind: "node", port: 3000, name: "kit", stage: "Preview" }];

test("Caddyfile: automatic HTTPS for verified domains only, never on-demand", () => {
  const cf = caddyfile([
    { host: "harlow-bakery.com", verified: true, deployment: A },
    { host: "pending.example.com", verified: false, deployment: A },
  ], W, { spaceName: "harlow.vyre.run" });
  assert.ok(cf.includes("harlow-bakery.com {"));
  assert.ok(!cf.includes("pending.example.com"));
  assert.ok(!/on_demand|ask |tls internal|auto_https off/.test(cf));
  assert.ok(cf.includes("0123456789abcdef".replace("0123", "fedc").replace("456789abcdef", "ba9876543210") + ".preview.harlow.vyre.run {"));
  assert.ok(cf.includes("X-Robots-Tag"));
  assert.ok(cf.includes(`reverse_proxy w-${A.slice(4)}:8080`));
  assert.ok(cf.includes(`reverse_proxy w-${B.slice(4)}:3000`));
});

test("Caddyfile: a production site with no domain gets the generated host; apex gets a www redirect; canonical www flips it", () => {
  const none = caddyfile([], W, { spaceName: "harlow.vyre.run" });
  assert.ok(none.includes("northwind.harlow.vyre.run {"));
  const apex = caddyfile([{ host: "harlow-bakery.com", verified: true, deployment: A }], W, { spaceName: "harlow.vyre.run" });
  assert.ok(apex.includes("www.harlow-bakery.com {") && apex.includes("redir https://harlow-bakery.com{uri} permanent"));
  const www = caddyfile([{ host: "harlow-bakery.com", verified: true, deployment: A, canonical: "www" }], W, { spaceName: "harlow.vyre.run" });
  assert.ok(www.includes("redir https://www.harlow-bakery.com{uri} permanent"));
  const nowww = caddyfile([{ host: "harlow-bakery.com", verified: true, deployment: A, www: false }], W, { spaceName: "harlow.vyre.run" });
  assert.ok(!nowww.includes("www.harlow-bakery.com"));
  const sub = caddyfile([{ host: "shop.harlow-bakery.com", verified: true, deployment: A }], W, { spaceName: "harlow.vyre.run" });
  assert.ok(!sub.includes("www.shop"));
  const vr = caddyfile([{ host: "northwind.vyre.run", verified: true, deployment: A }], W, { spaceName: "harlow.vyre.run" });
  assert.ok(!vr.includes("www.northwind.vyre.run"));
});

test("Caddyfile: security headers, no listing, size and time limits, logs without query strings", () => {
  const cf = caddyfile([], W, { spaceName: "harlow.vyre.run" });
  for (const h of ["Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "-Server"]) assert.ok(cf.includes(h), h);
  assert.ok(!/browse/.test(cf));
  assert.ok(cf.includes("max_size 10MB") && cf.includes("read_header 10s") && cf.includes("read_body 30s") && cf.includes("write 60s") && cf.includes("response_header_timeout 30s") && cf.includes("max_header_size 16KB"));
  assert.ok(cf.includes('request>uri regexp \\?.* ""'));
  assert.ok(cf.includes("request>headers>Authorization delete") && cf.includes("request>headers>Cookie delete"));
  assert.ok(cf.includes("admin off"));
});

test("Caddyfile injection attempts are refused: braces, newlines, spaces, wildcards, quotes, directives", () => {
  const hosts = [
    "evil.com {\n\treverse_proxy 10.0.0.1\n}\nx.com", "evil.com\nimport /etc/passwd", "a.com }", "a.com{", "*.example.com", "a b.com", "a.com;rm", 'a.com"x', "a.com#c",
    "a.com\r\nredir", "a.com/../x", "a.com:8080", "[::1]", "127.0.0.1", "0x7f.0.0.1", "2130706433", "localhost", "intranet.local", "svc.internal", "a.com$HOME", "{env.SECRET}.com", "a.com`id`", "a.com\u0000b",
  ];
  for (const host of hosts) throwsCode(() => caddyfile([{ host, verified: true, deployment: A }], W, { spaceName: "harlow.vyre.run" }), "bad_domain");
  throwsCode(() => caddyfile([], W, { spaceName: "harlow.vyre.run }\n{" }), "bad_domain");
  throwsCode(() => caddyfile([], [{ id: "dep_0123456789abcdef\n}", kind: "static", stage: "Production" }], { spaceName: "harlow.vyre.run" }), "bad_input");
  throwsCode(() => caddyfile([], [{ id: A, kind: "node", port: /** @type {any} */ ("3000\n}"), stage: "Production" }], { spaceName: "harlow.vyre.run" }), "bad_input");
  throwsCode(() => caddyfile([], [{ id: A, kind: "static", name: "a b {", stage: "Production" }], { spaceName: "harlow.vyre.run" }), "bad_input");
  // nothing a person typed ends up unescaped: every host line in a good file is a plain host
  const cf = caddyfile([{ host: "Harlow-Bakery.COM", verified: true, deployment: A }], W, { spaceName: "harlow.vyre.run" });
  for (const line of cf.split("\n").filter(l => /\{$/.test(l) && !/^\s/.test(l) && !l.startsWith("(") && l !== "{")) assert.match(line, /^[a-z0-9.-]+ \{$/);
  assert.ok(cf.includes("harlow-bakery.com {"));
});

test("duplicate hosts are refused; the same host cannot serve two sites", () => {
  throwsCode(() => caddyfile([{ host: "harlow-bakery.com", verified: true, deployment: A }, { host: "harlow-bakery.com", verified: true, deployment: A }], W, { spaceName: "harlow.vyre.run" }), "duplicate");
});

test("a punycode host is written in its ASCII form", () => {
  const cf = caddyfile([{ host: "bäckerei.de", verified: true, deployment: A }], W, { spaceName: "harlow.vyre.run" });
  assert.ok(cf.includes("xn--bckerei-5wa.de {"));
});

test("Caddyfile: a static site answers 404 for dotfiles and dot folders, except /.well-known/, and a node app is left to itself", () => {
  const cf = caddyfile([], W, { spaceName: "harlow.vyre.run" });
  const blocks = cf.split("\n\n");
  const stat = blocks.find(b => b.startsWith("northwind.harlow.vyre.run {"));
  const app = blocks.find(b => b.includes(`reverse_proxy w-${B.slice(4)}:3000`));
  assert.ok(stat.includes("@dotfiles") && stat.includes("path_regexp (^|/)\\.[^/]") && stat.includes("not path /.well-known/*") && stat.includes("respond @dotfiles 404"));
  assert.ok(stat.indexOf("respond @dotfiles 404") < stat.indexOf("reverse_proxy"), "refused before it is proxied");
  assert.ok(!app.includes("@dotfiles"));
});

test("the Caddy image: a plain copy of the binary (no file capability), non-root owned data and config", () => {
  const d = caddyDockerfile();
  assert.ok(/^FROM caddy:[^ ]+ AS official\nRUN cp \/usr\/bin\/caddy \/caddy\.plain/.test(d));
  assert.ok(d.includes("COPY --from=official /caddy.plain /usr/bin/caddy") && d.includes("chown -R 65532:65532 /data /config") && d.includes("USER 65532:65532"));
  assert.ok(!/setcap|cap_net/.test(d));
  throwsCode(() => caddyDockerfile("bad image;rm"), "bad_input");
  assert.equal(IMAGES.caddy, "vyre-publish-caddy:2.8");
});

test("a static site takes no environment or secrets, and no site gets outbound network yet", () => {
  throwsCode(() => edgeCompose(SPACE, [{ id: A, kind: "static", env: { X: "1" } }]), "isolation");
  throwsCode(() => edgeCompose(SPACE, [{ id: A, kind: "static", secrets: ["STRIPE_KEY"] }]), "isolation");
  for (const egress of [true, "yes", 1, "false", {}, [], "true"]) throwsCode(() => edgeCompose(SPACE, [{ id: B, kind: "node", image: IMG, port: 3000, egress }]), "isolation");
  assert.ok(edgeCompose(SPACE, [{ id: B, kind: "node", image: IMG, port: 3000, egress: false }]), "false is the same as absent");
  for (const bad of [{ env: "x" }, { env: ["A=1"] }, { secrets: "STRIPE_KEY" }, { secrets: [1] }, { limits: { mem: 5 } }, { limits: { gpu: 1 } }, { name: 5 }, { stage: 1 }]) throwsCode(() => edgeCompose(SPACE, [{ id: B, kind: "node", image: IMG, port: 3000, ...bad }]), "bad_input");
  // the generated compose is checked too: a workload joined to the egress bridge is a problem whatever put it there
  const c = edgeCompose(SPACE, [{ id: B, kind: "node", image: IMG, port: 3000 }]);
  c.services[`w-${B.slice(4)}`].networks.push("egress");
  assert.ok(isolationProblems(c).some(p => /network egress is not allowed for a workload/.test(p)));
  assert.ok(edgeCompose(SPACE, [{ id: A, kind: "static", name: "northwind" }]));
});

test("Caddyfile: the access log never keeps a join token", () => {
  const cf = caddyfile([], W, { spaceName: "harlow.vyre.run" });
  assert.ok(cf.includes("request>uri regexp ^(/join/).* ${1}redacted"));
});
