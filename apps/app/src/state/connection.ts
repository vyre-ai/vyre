import { create } from "zustand";

// How the box connection looks to the person (docs/adr/0029-resilience.md, R2 and R3).
//   live          the stream is open, or a blip is healing on its first retry (nothing shows)
//   reconnecting  one quiet pill, only after the first failed retry (about 2 s)
//   offline       the device itself has no network
// Writes waiting in the outbox show at once as "sending" and leave only on the box's answer:
// a result removes them, a refusal keeps them as "refused" with the reason until dismissed.

export type Connection = "live" | "reconnecting" | "offline";

/** stream.js's state, the part used here. */
export type StreamStateLike = { state: "connecting" | "open" | "reconnecting" | "paused" | "stopped"; attempt: number };

export type OutboxItem = {
  key: string;
  tool: string;
  input: unknown;
  at: number;
  status: "sending" | "needs_presence" | "refused";
  error?: { code: string; message: string };
};

/** Outbox entries, the part used here. */
export type PendingLike = { key: string; tool: string; input: unknown; at: number; state: "sending" | "waiting" | "needs_presence" };

/**
 * The R3 state from the stream's. `paths` is how many paths it tries per round: a failed round
 * is the first try, so the pill waits for the retry after it to fail too. Hidden (paused) keeps
 * what was showing.
 */
export function toConnection(s: StreamStateLike, o: { paths?: number; online?: boolean; was?: Connection } = {}): Connection {
  if (o.online === false) return "offline";
  if (s.state === "paused") return o.was === "reconnecting" ? "reconnecting" : "live";
  if (s.state === "reconnecting" && s.attempt > (o.paths ?? 1)) return "reconnecting";
  return "live";
}

/** The outbox list after a change: pending entries as sending, earlier refusals kept. */
export function toOutbox(prev: OutboxItem[], pending: PendingLike[], refused?: { entry: PendingLike; error: { code: string; message: string } }): OutboxItem[] {
  const keep = prev.filter((i) => i.status === "refused");
  if (refused) keep.push({ ...pick(refused.entry), status: "refused", error: refused.error });
  const live = pending.map((e): OutboxItem => ({ ...pick(e), status: e.state === "needs_presence" ? "needs_presence" : "sending" }));
  return [...live, ...keep];
}

const pick = (e: PendingLike) => ({ key: e.key, tool: e.tool, input: e.input, at: e.at });

type ConnectionState = {
  status: Connection;
  /** When the box last answered (an event or a heartbeat), for "since 14:02" after 60 s. */
  lastSeen: number | null;
  online: boolean;
  /** Paths per round, so a failed first round is not yet a pill. */
  paths: number;
  stream: StreamStateLike | null;
  outbox: OutboxItem[];
  /** The box asked for a person session: show a sign-in. */
  signIn: boolean;
};

const useConnectionStore = create<ConnectionState>()(() => ({
  status: "live",
  lastSeen: null,
  online: true,
  paths: 1,
  stream: null,
  outbox: [],
  signIn: false,
}));

const set = useConnectionStore.setState;
const get = useConnectionStore.getState;

// Read the store only through these hooks, so a screen re-renders on the slice it shows.
export const useConnection = () => useConnectionStore((s) => s.status);
export const useLastSeen = () => useConnectionStore((s) => s.lastSeen);
export const useOutbox = () => useConnectionStore((s) => s.outbox);
export const useSignInNeeded = () => useConnectionStore((s) => s.signIn);

// Writers, called by the box wiring (src/api/box.*.ts).
export const connection = {
  get: get,
  paths(n: number) {
    set({ paths: Math.max(1, n) });
  },
  stream(s: StreamStateLike) {
    const { online, paths, status } = get();
    set({ stream: s, status: toConnection(s, { paths, online, was: status }), ...(s.state === "open" ? { lastSeen: Date.now() } : {}) });
  },
  alive(at: number) {
    set({ lastSeen: at });
  },
  online(online: boolean) {
    const { stream, paths, status } = get();
    set({ online, status: stream ? toConnection(stream, { paths, online, was: status }) : online ? "live" : "offline" });
  },
  /** A write the person just made: on screen before the outbox has stored it. */
  sending(item: Omit<OutboxItem, "status">) {
    const list = get().outbox;
    if (!list.some((i) => i.key === item.key)) set({ outbox: [...list, { ...item, status: "sending" }] });
  },
  /** The outbox changed (outbox.js onChange). A row leaves only when this change answers it. */
  outbox(c: { pending: PendingLike[]; done?: { entry: PendingLike }; refused?: { entry: PendingLike; error: { code: string; message: string } } }) {
    const prev = get().outbox;
    const next = toOutbox(prev, c.pending, c.refused);
    const answered = c.done?.entry.key ?? c.refused?.entry.key;
    const known = new Set(next.map((i) => i.key));
    // A row put up by sending() before the outbox stored it stays until the outbox has it.
    const early = prev.filter((i) => i.status === "sending" && !known.has(i.key) && i.key !== answered);
    set({ outbox: [...next, ...early] });
  },
  dismiss(key: string) {
    set({ outbox: get().outbox.filter((i) => !(i.key === key && i.status === "refused")) });
  },
  signIn(needed: boolean) {
    set({ signIn: needed });
  },
};
