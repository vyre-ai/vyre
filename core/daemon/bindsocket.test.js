// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { bindSocket } from "./index.js";

/** A stand-in for http.Server: `attempts` listen() calls fail with `code`, then it succeeds. */
function fakeServer(failures, code = "EACCES") {
  const em = new EventEmitter();
  let calls = 0;
  return Object.assign(em, {
    calls: () => calls,
    listen(/** @type {string} */ _socket, /** @type {() => void} */ cb) {
      calls++;
      if (calls <= failures) {
        const e = /** @type {any} */ (new Error(`listen ${code}`));
        e.code = code;
        queueMicrotask(() => em.emit("error", e));
      } else {
        queueMicrotask(cb);
      }
    },
  });
}

test("bindSocket: off win32, any listen error is thrown at once, no retry", async () => {
  const server = fakeServer(1);
  await assert.rejects(
    bindSocket(server, "/tmp/x.sock", { platform: "darwin", wait: () => Promise.resolve() }),
    /EACCES/,
  );
  assert.equal(server.calls(), 1);
});

test("bindSocket: on win32, a transient EACCES/EPERM is retried until it succeeds", async () => {
  const server = fakeServer(3, "EPERM");
  const waited = [];
  await bindSocket(server, "/tmp/x.sock", { platform: "win32", wait: ms => { waited.push(ms); return Promise.resolve(); } });
  assert.equal(server.calls(), 4);
  assert.deepEqual(waited, [150, 300, 450]);
});

test("bindSocket: on win32, a non-transient error is thrown at once", async () => {
  const server = fakeServer(1, "EADDRINUSE");
  await assert.rejects(
    bindSocket(server, "/tmp/x.sock", { platform: "win32", wait: () => Promise.resolve() }),
    /EADDRINUSE/,
  );
  assert.equal(server.calls(), 1);
});

test("bindSocket: on win32, it gives up after its attempt budget and throws the last error", async () => {
  const server = fakeServer(50, "EACCES");
  await assert.rejects(
    bindSocket(server, "/tmp/x.sock", { platform: "win32", wait: () => Promise.resolve() }),
    /EACCES/,
  );
  assert.equal(server.calls(), 10);
});
