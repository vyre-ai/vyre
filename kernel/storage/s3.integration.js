// Run by hand against a real S3-compatible service (the spike's SeaweedFS: seaweed.sh): VYRE_S3=http://127.0.0.1:8333 VYRE_S3_KEY=... VYRE_S3_SECRET=... VYRE_S3_BUCKET=pool node kernel/storage/s3.integration.js
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { s3Backend, dirBackend } from "./backends.js";
import { Pool } from "./pool.js";

const be = s3Backend({ endpoint: process.env.VYRE_S3, bucket: process.env.VYRE_S3_BUCKET || "pool", key: process.env.VYRE_S3_KEY, secret: process.env.VYRE_S3_SECRET, region: "us-east-1", prefix: `it-${Date.now()}/` });
await be.ping();
const k = "c/" + crypto.randomBytes(8).toString("hex"), v = crypto.randomBytes(300_000);
await be.put(k, v); assert.deepEqual(await be.get(k), v); await be.del(k); assert.equal(await be.get(k), null);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-s3it-")), MB = 1 << 20;
const pool = new Pool({ dir, key: Buffer.alloc(32, 3), chunk: MB });
pool.addNode({ id: "home", backend: dirBackend(path.join(dir, "home")), home: true, offered: 100 * MB });
pool.addNode({ id: "bucket", backend: be, kind: "s3", copies: 2, offered: 100 * MB });
const data = crypto.randomBytes(3 * MB + 5), r = await pool.put(data, { class: "working" });
assert.equal(r.atRisk, false); assert.deepEqual(await pool.get(r.id), data);
await pool.remove(r.id); fs.rmSync(dir, { recursive: true, force: true });
console.log("s3 integration ok");
