// Vyre mail bridge: a Google Apps Script web app that lets your own Vyre search, read and send
// your Gmail (ADR 0016 decision 8). It runs as you, inside your Google account, and answers only
// a request that carries the token you choose below.
//
// Setup, once:
//   1. Open https://script.google.com while signed in to the Gmail account Vyre should use, and
//      make a New project.
//   2. Replace the contents of Code.gs with this whole file and save.
//   3. Project Settings (the gear) > Script Properties > Add script property. Name: vyre_token.
//      Value: a long random value, at least 32 characters (a password manager can make one).
//   4. Deploy > New deployment > Select type: Web app. Execute as: Me. Who has access: Anyone.
//      Deploy, and allow the Gmail access Google asks for.
//   5. Copy the Web app URL, the one that ends in /exec.
//   6. In Vyre, keep the URL and the token together in the vault as one env-set with the fields
//      "url" and "token", and add the mail account with adapter "apps-script".
//
// Why "Anyone": Vyre calls this URL without a Google sign-in. The token is what keeps everyone
// else out, so keep it secret, and change both the property and the vault item if it leaks.
// To stop Vyre, archive the deployment (Deploy > Manage deployments).
//
// Every answer is JSON: {ok: true, data} or {ok: false, error, code}. The script never echoes the
// token, and a request without the right token learns nothing but "auth".
// Plain Apps Script (V8), no libraries.

var MAX_LIMIT = 25;
var BODY_CAP = 20000;
var SNIPPET = 200;

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || "");
  } catch (err) {
    return answer_(false, "the request is not JSON", "bad_input");
  }
  if (!req || typeof req !== "object") return answer_(false, "the request is not a JSON object", "bad_input");

  var expected = PropertiesService.getScriptProperties().getProperty("vyre_token") || "";
  if (expected.length < 16) return answer_(false, "set the vyre_token script property to a long random value", "setup");
  if (!same_(String(req.token || ""), expected)) return answer_(false, "wrong token", "auth");

  try {
    if (req.op === "test") return answer_(true, { address: Session.getEffectiveUser().getEmail() });
    if (req.op === "search") return answer_(true, search_(req));
    if (req.op === "read") return answer_(true, read_(req));
    if (req.op === "send") return answer_(true, send_(req));
    return answer_(false, "unknown op", "bad_input");
  } catch (err) {
    if (err && err.vyreCode) return answer_(false, err.message, err.vyreCode);
    return answer_(false, "Gmail refused: " + String((err && err.message) || err).slice(0, 300), "gmail");
  }
}

// A GET (someone opening the URL in a browser) gets nothing useful.
function doGet() {
  return answer_(false, "this web app only answers Vyre's POST requests", "bad_input");
}

function search_(req) {
  var q = typeof req.q === "string" ? req.q : "";
  var limit = Math.floor(Number(req.limit) || 10);
  if (limit < 1) limit = 1;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  var threads = GmailApp.search(q, 0, limit);
  var out = [];
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    if (!msgs.length) continue;
    var m = msgs[msgs.length - 1];
    out.push({
      id: m.getId(),
      thread_id: threads[i].getId(),
      from: m.getFrom(),
      to: m.getTo(),
      subject: m.getSubject(),
      date: m.getDate().toISOString(),
      snippet: String(m.getPlainBody() || "").replace(/\s+/g, " ").trim().slice(0, SNIPPET),
    });
  }
  return out;
}

function read_(req) {
  if (typeof req.id !== "string" || !req.id) throw fail_("read needs an id", "bad_input");
  var m = null;
  try { m = GmailApp.getMessageById(req.id); } catch (err) { m = null; }
  if (!m) throw fail_("no message with that id", "not_found");
  var names = [];
  var atts = m.getAttachments();
  for (var i = 0; i < atts.length; i++) names.push(atts[i].getName());
  return {
    id: m.getId(),
    thread_id: m.getThread().getId(),
    from: m.getFrom(),
    to: m.getTo(),
    cc: m.getCc(),
    subject: m.getSubject(),
    date: m.getDate().toISOString(),
    message_id: m.getHeader("Message-ID") || "",
    body: String(m.getPlainBody() || "").slice(0, BODY_CAP),
    attachments: names,
  };
}

function send_(req) {
  var to = list_(req.to);
  var cc = list_(req.cc);
  var bcc = list_(req.bcc);
  if (!to.length) throw fail_("send needs at least one address in to", "bad_input");
  if (typeof req.subject !== "string" || /[\r\n]/.test(req.subject)) throw fail_("send needs a subject on one line", "bad_input");
  if (typeof req.body !== "string") throw fail_("send needs a body", "bad_input");

  if (req.in_reply_to) {
    var id = String(req.in_reply_to);
    var threads = GmailApp.search("rfc822msgid:" + id.replace(/^</, "").replace(/>$/, ""), 0, 1);
    if (!threads.length) throw fail_("no message with that Message-ID to reply to", "not_found");
    var msgs = threads[0].getMessages();
    var target = msgs[msgs.length - 1];
    for (var i = 0; i < msgs.length; i++) if (msgs[i].getHeader("Message-ID") === id) target = msgs[i];
    // Gmail's reply goes to the original sender. The person approved `to`, so a reply whose
    // sender is not in `to` is refused rather than sent somewhere they never saw, and any other
    // address in `to` is copied, so everyone they approved gets it.
    var replyTo = addressOf_(target.getReplyTo() || target.getFrom());
    var lower = to.map(function (a) { return a.toLowerCase(); });
    if (lower.indexOf(replyTo.toLowerCase()) < 0) throw fail_("a reply goes to " + replyTo + "; put that address in to", "reply_mismatch");
    var extra = to.filter(function (a) { return a.toLowerCase() !== replyTo.toLowerCase(); });
    var opts = {};
    if (cc.length || extra.length) opts.cc = extra.concat(cc).join(",");
    if (bcc.length) opts.bcc = bcc.join(",");
    target.reply(req.body, opts);
    return { sent: true };
  }

  var options = {};
  if (cc.length) options.cc = cc.join(",");
  if (bcc.length) options.bcc = bcc.join(",");
  GmailApp.sendEmail(to.join(","), req.subject, req.body, options);
  return { sent: true };
}

// Compare every character whatever the first difference, so the time taken says nothing about
// how much of a guessed token was right.
function same_(a, b) {
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i % (a.length || 1)) | 0) ^ (b.charCodeAt(i % (b.length || 1)) | 0);
  }
  return diff === 0;
}

function list_(v) {
  if (!v) return [];
  var arr = Array.isArray(v) ? v : String(v).split(",");
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var a = String(arr[i]).trim();
    if (!a) continue;
    if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(a)) throw fail_("not an email address: " + a.slice(0, 80), "bad_input");
    out.push(a);
  }
  return out;
}

function addressOf_(from) {
  var m = /<([^<>\s]+@[^<>\s]+)>/.exec(String(from || ""));
  return m ? m[1] : String(from || "").trim();
}

function fail_(message, code) {
  var err = new Error(message);
  err.vyreCode = code;
  return err;
}

function answer_(ok, dataOrError, code) {
  var body = ok ? { ok: true, data: dataOrError } : { ok: false, error: dataOrError, code: code };
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
