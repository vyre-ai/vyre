// @ts-check
// drop: sending a whole file between the Mac and the box, and the inbox it lands in.
//
// The old way rode on another product's file transfer between a person's devices. That product is gone from Vyre, and its replacement,
// VyreDrop (store and forward through the home's inbox over the encrypted device stream, resumable, working for an offline device, a phone or a browser;
// SPEC-wink-network 7.2), is not built yet (team/BACKLOG.md, "What the old network carried"). Until then the tools stay registered, so surfaces, grants and
// the CLI keep their shape, and each says plainly that it cannot send. Nothing here reads a file's bytes, spawns a program or touches a network.
// `files.fetch` still brings a box file down through the link, a chunk at a time.

import path from "node:path";
import os from "node:os";
import * as config from "../config/index.js";

/** The box's inbox when config files.inbox is not set: inside /work, the box's default root. */
export const INBOX = "/work/inbox";
/** A Mac's inbox when config files.inbox is not set: inside its home, a Mac's default root. */
export const macInbox = () => path.join(os.homedir(), "Vyre", "inbox");

const WHY = "sending a file between your devices is coming back with VyreDrop; until then, use files.fetch to bring a server file down, or put the file in a shared folder";
const unable = () => Object.assign(new Error(WHY), { code: "unavailable" });

/**
 * Register the tools for this machine's role: on the Mac files.send and files.receive, on the box files.deliver.
 * @param {any} ctx the files module's context
 * @param {{ role: "box"|"local", g: ReturnType<typeof import("./safety.js").guard>, cfg: any }} opts
 * @returns {{ stop(): Promise<void> }}
 */
export function drop(ctx, { role, g, cfg }) {
  if (role === "local") {
    ctx.tool("files.send", {
      description: "Send a file from this Mac to your server. Not available yet: it comes back with VyreDrop.",
      input: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
      callers: ["cli", "capsule", "local"],
      run: async ({ path: p }) => { g.resolveSafe(p); throw unable(); },
    });
    ctx.tool("files.receive", {
      description: "Turn on or off whether this Mac takes in files the server delivers. The choice is remembered; delivery itself comes back with VyreDrop.",
      input: { type: "object", required: ["on"], properties: { on: { type: "boolean" } } },
      callers: ["cli", "local", "deck", "capsule"],
      run: async ({ on }) => {
        const next = on === true;
        if (next === (cfg.receive === true)) return { on: next, changed: false };
        if (!ctx.paths) throw new Error("this vyred has no home to save config in");
        config.save({ files: { receive: next } }, ctx.paths.root, ctx.config);
        cfg.receive = next;
        return { on: next, changed: true };
      },
    });
    return { async stop() {} };
  }
  ctx.tool("files.deliver", {
    description: "Send a file from the server to a paired Mac. Not available yet: it comes back with VyreDrop.",
    input: { type: "object", required: ["path", "mac"], properties: { path: { type: "string" }, mac: { type: "string", description: "A paired Mac's id or name (link.macs, vyre link)." } } },
    callers: ["cli", "local", "deck", "capsule"],
    run: async ({ path: p }) => { g.resolveSafe(p); throw unable(); },
  });
  return { async stop() {} };
}
