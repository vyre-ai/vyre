// @ts-check
// The daemon's side of core/daemon/threadsock-groups.test.js: opens one session's socket as vyre (uid 1000, in the account groups), prints its path, and stays until stdin ends.
import { openThreadSocket } from "./threadsock.js";

const sock = await openThreadSocket({ handler: () => async (_req, res) => { res.end("ok"); }, thread: "t1", pids: async () => ({ pids: [] }), gid: Number(process.env.SOCK_GID), log: () => {} });
process.stdout.write(`${sock.path}\n`);
if (process.env.SOCK_REGROUP) { sock.setGroup(Number(process.env.SOCK_REGROUP)); process.stdout.write("regrouped\n"); }
process.stdin.resume();
process.stdin.on("end", async () => { await sock.close(); process.exit(0); });
