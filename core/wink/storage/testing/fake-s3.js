// @ts-check
// A fake S3 server for tests: path-style ListObjectsV2 on one bucket, checking the request's signature against the known secret.
import http from "node:http";
import { signRequest } from "../s3.js";

/** @param {{ bucket: string, accessKey: string, secretKey: string, region?: string, slow?: boolean }} o */
export async function fakeS3(o) {
  /** @type {{ method: string, url: string, auth: string }[]} */ const seen = [];
  let down = false;
  const srv = http.createServer((req, res) => {
    seen.push({ method: String(req.method), url: String(req.url), auth: String(req.headers.authorization || "") });
    if (down) { res.statusCode = 503; res.end("<Error><Code>SlowDown</Code></Error>"); return; }
    const err = (/** @type {number} */ st, /** @type {string} */ code) => { res.statusCode = st; res.setHeader("content-type", "application/xml"); res.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`); };
    const auth = String(req.headers.authorization || "");
    const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(auth);
    if (!m) return err(403, "AccessDenied");
    if (m[1] !== o.accessKey) return err(403, "InvalidAccessKeyId");
    const amz = String(req.headers["x-amz-date"]);
    const date = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
    const expect = signRequest({ method: String(req.method), url: `http://${req.headers.host}${req.url}`, region: m[3], accessKey: o.accessKey, secretKey: o.secretKey, date });
    if (expect.signature !== m[5]) return err(403, "SignatureDoesNotMatch");
    if (!String(req.url).startsWith(`/${o.bucket}?`)) return err(404, "NoSuchBucket");
    if (!/list-type=2/.test(String(req.url)) || !/max-keys=1(&|$)/.test(String(req.url))) return err(400, "InvalidArgument");
    res.setHeader("content-type", "application/xml");
    res.end(`<?xml version="1.0"?><ListBucketResult><Name>${o.bucket}</Name><KeyCount>0</KeyCount></ListBucketResult>`);
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (srv.address()).port;
  return { endpoint: `http://127.0.0.1:${port}`, seen, setDown: (/** @type {boolean} */ v) => { down = v; }, close: () => { srv.closeAllConnections(); srv.close(); } };
}
