// One Glass screen's life in the web app, as a hook: the target read from glass.targets and kept current by the box's events, the stream's connect, reconnect and pause (the Deck's rules,
// deck/glass/watch.js), the keyboard (take, hand back, the idle countdown) and the activity log. The picture itself is the iframe's (src/glass/frame.js); this speaks to it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { boxOrigin, listen } from "../../src/api/box";
import { APP_BASE } from "../../src/pwa/model";
import type { GlassFrameHandle } from "./GlassFrame";
import { glass } from "./source-real";
import { EVENTS, LIFECYCLE, handedBackBanner, agentOf, closeMeaning, errText, eventLine, isRepeat, levels, mine as isMine, nextBackoff, other as isOther, pickTargets,
  type Conn, type Holder, type Link, type Target } from "./model";

/** The frame page: on the web the app's own, on the phone the paired box's (the WebView needs an absolute address). */
export const frameUrl = (): string => `${Platform.OS === "web" ? "" : boxOrigin()}${APP_BASE}/glass/frame.html`;

/** This browser's surface id: glass:<id>, kept so a reload is the same screen. */
let phoneId = "";
export function surfaceId(): string {
  let id = "";
  try { id = window.localStorage.getItem("vyre.glass.surface") || ""; } catch {}
  if (!/^[a-z0-9]{6,32}$/.test(id)) {
    // a phone has no localStorage and may have no crypto.getRandomValues: it keeps its id for as long as the app runs, which is as long as a screen is held
    const bytes = typeof crypto !== "undefined" && crypto.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(8))) : Array.from({ length: 8 }, () => Math.floor(Math.random() * 256));
    id = phoneId || bytes.map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
    phoneId = id;
    try { window.localStorage.setItem("vyre.glass.surface", id); } catch {}
  }
  return `glass:${id}`;
}

const slowNet = (): boolean => {
  const c = typeof navigator === "undefined" ? null : (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return Boolean(c && (c.saveData || /^(slow-2g|2g|3g)$/.test(c.effectiveType || "")));
};
/** The stream's address: the box's own origin as a socket. "" when the box is only reached over the relay (the stream is direct). */
const wsBase = (): string => { const o = boxOrigin(); return o ? o.replace(/^http/, "ws") : relayOnly() ? RELAY_HOST : ""; };
/** The phone away from the server: no address of the box, only the relay channel. The page opens `ws://<anything>` + path and the app's bridge keeps only the path (contracts/glass-relay.md). */
export const relayOnly = (): boolean => Platform.OS !== "web" && !boxOrigin();
const RELAY_HOST = "ws://box.invalid";

export type Note = { tone: "ok" | "err"; title?: string; text: string };

export function useGlass(name: string, target: string) {
  const surface = useMemo(surfaceId, []);
  const frame = useRef<GlassFrameHandle | null>(null);
  const [info, setInfo] = useState<Target | null>(null);
  const [loaded, setLoaded] = useState<"loading" | "ready" | "missing" | "offline">("loading");
  const [conn, setConn] = useState<Conn>("hidden");
  const [why, setWhy] = useState("");
  const [link, setLink] = useState<Link | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [holder, setHolder] = useState<Holder | null>(null);
  const [idleAt, setIdleAt] = useState(0);
  const [log, setLog] = useState<{ at: number; text: string }[]>([]);
  const [notice, setNotice] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const [fit, setFit] = useState(true);
  const [ready, setReady] = useState(false);

  // Refs hold what the async paths need now, so a late answer never acts on an old screen.
  const gen = useRef(0);
  const session = useRef<string | null>(null);
  const backoff = useRef(1);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dead = useRef(false);
  const lastLog = useRef({ text: "", at: 0 });
  const connRef = useRef<Conn>("hidden");
  const holderRef = useRef<Holder | null>(null);
  const setC = (c: Conn) => { connRef.current = c; setConn(c); };
  const setH = (h: Holder | null) => { holderRef.current = h; setHolder(h); };
  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

  const addLog = useCallback((text: string) => {
    if (!text) return;
    const now = Date.now();
    if (isRepeat(lastLog.current, text, now)) return;
    lastLog.current = { text, at: now };
    setLog((l) => [{ at: now, text }, ...l].slice(0, 40));
  }, []);

  const closeSession = useCallback(async () => {
    const sid = session.current;
    session.current = null;
    if (sid) await glass.close(sid).catch(() => {});
  }, []);

  const later = useCallback((reason: string, connect: () => void) => {
    setC("waiting"); setWhy(`${reason} Trying again in ${backoff.current} s.`);
    if (!visible() || dead.current) return;
    if (retry.current) clearTimeout(retry.current);
    retry.current = setTimeout(connect, backoff.current * 1000);
    backoff.current = nextBackoff(backoff.current);
  }, []);

  const connect = useCallback(async () => {
    if (dead.current || !visible()) return;
    if (retry.current) { clearTimeout(retry.current); retry.current = null; }
    const my = ++gen.current;
    if (connRef.current !== "waiting") setC("connecting");
    await closeSession();
    let r;
    try { r = await glass.open(target, surface); }
    catch (e) {
      if (dead.current || my !== gen.current) return;
      const x = e as { code?: string; message?: string };
      setWhy(errText(x));
      if (x.code === "offline") { later(errText(x), connect); return; }
      setC("error");
      return;
    }
    if (dead.current || my !== gen.current) { if (r.session) glass.close(r.session).catch(() => {}); return; }
    session.current = r.session;
    setLink(r.link);
    if (!r.screen) { setC("noscreen"); setWhy(""); return; }
    if (r.screen.width && r.screen.height) setSize({ w: r.screen.width, h: r.screen.height });
    const base = wsBase();
    if (!base) { setC("error"); setWhy("Glass reaches your server directly. Open this app on your server's own address."); return; }
    const [quality, compression] = levels(r.link, slowNet());
    frame.current?.post({ t: "connect", url: base + r.screen.path, quality, compression, fit: true });
  }, [closeSession, later, surface, target]);

  /** What the frame says. */
  const onFrame = useCallback((m: { t: string; code?: number; reason?: string; clean?: boolean; sent?: number; cut?: boolean }) => {
    if (dead.current) return;
    if (m.t === "ready") { setReady(true); return; }
    if (m.t === "live") { backoff.current = 1; setC("live"); setWhy(""); frame.current?.post({ t: "holding", on: isMine(holderRef.current, surface) }); return; }
    if (m.t === "handback") { void release(""); return; }
    if (m.t === "paste") { if (m.cut) addLog(`Pasted the first ${m.sent} characters; Glass types at most 4 KB of a paste.`); return; }
    if (m.t === "security") { setWhy(String(m.reason || "Your server refused the screen.")); return; }
    if (m.t === "down") {
      const c = closeMeaning(Number(m.code) || 0, String(m.reason || ""), Boolean(m.clean));
      if ("retry" in c) later(c.retry, connect); else { setC(c.conn); setWhy(c.why); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLog, connect, later, surface]);

  const refresh = useCallback(async () => {
    try {
      const rows = pickTargets(await glass.targets());
      const row = rows.find((t) => t.target === target) ?? null;
      if (dead.current) return;
      setInfo(row);
      if (row) {
        const had = isMine(holderRef.current, surface);
        setH(row.holder);
        if (had && !isMine(row.holder, surface)) addLog(`The keyboard went back to ${name}.`);
        frame.current?.post({ t: "holding", on: isMine(row.holder, surface) && connRef.current === "live" });
      }
    } catch { /* the page keeps what it had */ }
  }, [addLog, name, surface, target]);

  // Start: read the targets, then connect while the tab is visible.
  useEffect(() => {
    dead.current = false;
    glass.targets().then((t) => {
      if (dead.current) return;
      const row = t.find((x) => x.target === target) ?? null;
      setInfo(row); setH(row?.holder ?? null); setLoaded("ready");
    }).catch((e) => { if (!dead.current) setLoaded((e as { code?: string }).code === "no_such_tool" ? "missing" : "offline"); });
    return () => { dead.current = true; if (retry.current) clearTimeout(retry.current); frame.current?.post({ t: "drop" }); void closeSession(); };
  }, [target, closeSession]);

  // Connect once the frame is ready and the target is known to have a screen.
  const hasScreen = target !== "box" && info?.screen !== false;
  useEffect(() => {
    if (!ready || loaded !== "ready" || !hasScreen) return;
    if (visible()) void connect(); else setC("hidden");
  }, [ready, loaded, hasScreen, connect]);

  // A hidden tab lets go of the screen and keeps the last frame; visible again, a fresh ticket.
  useEffect(() => {
    if (Platform.OS !== "web" || !hasScreen) return;
    const on = () => {
      if (dead.current) return;
      if (document.visibilityState === "hidden") { gen.current++; if (retry.current) clearTimeout(retry.current); frame.current?.post({ t: "drop" }); void closeSession(); setC("hidden"); }
      else { backoff.current = 1; void connect(); }
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [connect, closeSession, hasScreen]);

  // The box's events for this computer.
  useEffect(() => {
    if (!hasScreen) return;
    const stop = listen((e) => {
      if (dead.current || !(EVENTS as string[]).includes(e.type)) return;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (agentOf(p) !== name && p.target !== target) return;
      switch (e.type) {
        case "computer.taken-over": case "glass.taken":
          if (!holderRef.current || holderRef.current.surface !== p.surface) setH({ surface: String(p.surface), since: Number(p.since) || Date.now(), private: Boolean(p.private) });
          break;
        case "computer.idle-warning":
          if (p.surface !== surface) return;
          setIdleAt(p.at ? Date.now() + Math.max(0, Number(p.at) - Number((e as { at?: number }).at || Date.now())) : 0);
          return;
        case "computer.handed-back": case "glass.released":
          if (holderRef.current && (!p.surface || holderRef.current.surface === p.surface)) setH(null);
          if (p.surface === surface) { setIdleAt(0); if (p.why === "idle") setNotice({ tone: "ok", text: `Handed back to ${name} after ${Math.round(Number(p.idle_ms) / 60_000)} min idle.` }); }
          break;
        case "glass.opened": case "glass.closed": void refresh(); break;
        default: if (LIFECYCLE.includes(e.type)) { void refresh(); return; }
      }
      addLog(eventLine(e.type, p, name, surface));
      frame.current?.post({ t: "holding", on: isMine(holderRef.current, surface) && connRef.current === "live" });
    });
    return stop;
  }, [addLog, hasScreen, name, refresh, surface, target]);

  const take = useCallback(async (priv: boolean) => {
    if (busy || isMine(holderRef.current, surface)) return;
    setBusy(true);
    try {
      const h = await glass.take(target, surface, priv);
      setNotice(null); setH(h);
      frame.current?.post({ t: "holding", on: connRef.current === "live" });
    } catch (e) { setNotice({ tone: "err", title: priv ? "Private sign-in did not start" : "Take-over did not start", text: errText(e as { code?: string; message?: string }) }); }
    setBusy(false);
  }, [busy, surface, target]);

  async function release(note: string) {
    if (!isMine(holderRef.current, surface)) return;
    setBusy(true);
    try {
      const r = await glass.release(target, surface, note);
      setH(null); setIdleAt(0);
      frame.current?.post({ t: "holding", on: false });
      setNotice({ tone: "ok", text: handedBackBanner(name, r.heldMs, note, r.noted) });
    } catch (e) { setNotice({ tone: "err", title: "Hand-back did not go through", text: errText(e as { code?: string; message?: string }) }); }
    setBusy(false);
  }

  const setFitting = useCallback((on: boolean) => { setFit(on); frame.current?.post({ t: "fit", on }); }, []);
  const retryNow = useCallback(() => { backoff.current = 1; void connect(); }, [connect]);

  return { surface, frame, onFrame, info, loaded, conn, why, link, size, holder, idleAt, log, notice, setNotice, busy, fit, setFitting, take, release, retryNow,
    mine: isMine(holder, surface), other: isOther(holder, surface), hasScreen };
}
