// The invite page: read the token from the path, check that the Vyre web app answers (a request to its address alone, which carries nothing of the invite), then go to it with the token in the fragment. If the app
// does not answer, say so in plain words with the way to get the app and the button to try again. Nothing is stored and nothing is sent anywhere else.
import { WEB_APP, WORDS, inviteTarget } from "./target.js";

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const target = inviteTarget(location.pathname);
const open = /** @type {HTMLAnchorElement} */ ($("open"));

if (!target) {
  $("title").textContent = "This invite link is not complete";
  $("lead").textContent = WORDS.incomplete;
  $("title").focus();
} else {
  open.href = target;
  open.hidden = false;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 5000);
  fetch(`${WEB_APP}/`, { mode: "no-cors", cache: "no-store", referrerPolicy: "no-referrer", signal: stop.signal })
    .then(() => { clearTimeout(timer); location.replace(target); })
    .catch(() => {
      clearTimeout(timer);
      $("title").textContent = "The Vyre app did not open";
      open.textContent = WORDS.retry;
      $("fallback").hidden = false;
      $("title").focus();
    });
}
