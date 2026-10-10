// The loop that tells you when you are not looking: asks the server over the connection the app already keeps (approvals.pending, threads.list) and shows each new thing as a local notice
// (notify.ts: no push service, no token). Android and iPhone alike; an iPhone that is closed shows it when the app opens, because the loop runs then. Nothing is asked while the app is in front.
import { AppState } from "react-native";
import { call } from "../api/box";
import { showLocal } from "./notify";
import { approvalNotices, doneNotices, sharedLoop } from "./notices-model.js";

/** How often the server is asked while the app is alive in the background. */
const EVERY_MS = 20_000;

/** Start the loop. Returns the stop. `open` says which session the person has open, so it is not told "done" about it. */
/** Start the loop, once for the whole app: the screen and the headless task (the app closed, kept alive by the service) both ask, and the loop is one (notices-model.js sharedLoop). Returns this caller's stop. */
const shared = sharedLoop((open: () => string | null) => runNotices(open));
export function startNotices(open: () => string | null = () => null): () => void { return shared(open); }

function runNotices(open: () => string | null): () => void {
  let seen = new Set<string>();
  let was = new Map<string, string>();
  let first = true;
  let live = true;
  const look = async () => {
    if (!live) return;
    const looking = AppState.currentState === "active";
    try {
      const [p, t] = await Promise.all([call<any>("approvals.pending", {}), call<any>("threads.list", {})]);
      const a = approvalNotices(seen, p.error ? null : p.data);
      const d = doneNotices(was, Array.isArray(t.data) ? t.data : t.data && Array.isArray(t.data.threads) ? t.data.threads : [], { openId: open() });
      seen = a.seen;
      was = d.was;
      // the first look only learns what is already there; nothing old is announced
      if (!first && !looking) for (const n of [...a.notices, ...d.notices]) void showLocal(n);
      first = false;
    } catch { /* the server is away: the next look tries again */ }
  };
  void look();
  const timer = setInterval(look, EVERY_MS);
  const sub = AppState.addEventListener("change", (s) => { if (s === "active") void look(); });
  return () => { live = false; clearInterval(timer); sub.remove(); };
}
