// A small W3C WebDriver client, for Safari (safaridriver) where DevTools isn't there. The same
// surface as lib/cdp.mjs's page, so a journey runs on either.
/** @param {string} base for example http://127.0.0.1:4444 */
export async function connect(base, browserName = "safari") {
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (j.value && j.value.error) throw new Error(`${path}: ${j.value.error}: ${j.value.message}`);
    return j.value;
  };
  const { sessionId } = await call("POST", "/session", { capabilities: { alwaysMatch: { browserName } } });
  const s = (method, path, body) => call(method, `/session/${sessionId}${path}`, body);
  const evaluate = expr => s("POST", "/execute/sync", { script: `return (${expr});`, args: [] });
  return {
    logs: [],
    evaluate,
    async open(url) {
      await s("POST", "/url", { url });
      // WebDriver has no status code; a page that loaded with its own title stands in for 200.
      return String(await evaluate("document.readyState")) === "complete" ? 200 : 0;
    },
    async waitText(re, timeoutMs = 20000) {
      const until = Date.now() + timeoutMs;
      let text = "";
      while (Date.now() < until) {
        text = String(await evaluate("document.body ? document.body.innerText : ''"));
        if (re.test(text)) break;
        await new Promise(r => setTimeout(r, 250));
      }
      return text;
    },
    async shot() { return Buffer.from(await s("GET", "/screenshot"), "base64"); },
    async close() { try { await s("DELETE", ""); } catch {} },
  };
}
