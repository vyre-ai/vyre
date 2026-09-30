// @ts-check
// A fake GitHub for the native bar's world (core/github/connect.js's real URLs, never a real
// network call): device flow and /user, the same shape as core/github/connect.test.js's own fake,
// but wired in as a global fetch() intercept so a real spawned vyred can run github.connect for
// real. Opt-in only (FAKE_GITHUB_ENABLE=1), preloaded with `--import` before core/daemon/main.js
// starts, so connect.js's connector() (built at module start, `deps.fetch || globalThis.fetch`)
// captures the wrapped fetch. Everything that is not one of GitHub's three device-flow URLs goes
// to the real fetch unchanged. A test helper, not part of the product.

if (process.env.FAKE_GITHUB_ENABLE === "1") {
  const DEVICE_CODE_URI = "https://github.com/login/device/code";
  const TOKEN_URI = "https://github.com/login/oauth/access_token";
  const USER_URI = "https://api.github.com/user";
  const login = process.env.FAKE_GITHUB_LOGIN || "alex-harlow";
  const pendingPolls = Number(process.env.FAKE_GITHUB_PENDING_POLLS || "1");
  const declineAfter = process.env.FAKE_GITHUB_DECLINE === "1" ? 0 : null;
  let polls = 0;
  const real = globalThis.fetch;
  const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u === DEVICE_CODE_URI) {
      return jsonRes(200, { device_code: "fake-device-code-abc", user_code: "WXYZ-1234", verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=WXYZ-1234", expires_in: 900, interval: 0 });
    }
    if (u === TOKEN_URI) {
      polls++;
      if (declineAfter !== null && polls > declineAfter) return jsonRes(200, { error: "access_denied" });
      if (polls <= pendingPolls) return jsonRes(200, { error: "authorization_pending" });
      return jsonRes(200, { access_token: "fake-gh-token-xyz", token_type: "bearer", scope: "repo" });
    }
    if (u === USER_URI) return jsonRes(200, { login, avatar_url: `https://avatars.example/${login}.png` });
    return real(url, opts);
  };
}
