// @ts-check
// A chat as the app starts it, for a journey or a walk: one place (apps/app/src/state/persistent-chat.ts is the app's own).
import crypto from "node:crypto";
import { createRing, holdersOf } from "../../../lib/chat-keys.js";
import { whenStoreIsUp } from "./store.mjs";

/**
 * A chat as the app starts it: its device makes the chat's key ring (a chat with a person in it is never in the clear), then work.chat.create takes the id and the ring.
 * @param {any} w @param {string} title
 */
export async function startChat(w, title, agents = /** @type {string[]} */ ([])) {
  const dev = crypto.createECDH("prime256v1"); dev.generateKeys();
  const id = `chat_${crypto.randomUUID()}`;
  const ring = createRing(id, holdersOf([{ device: "dev_journey", agree: dev.getPublicKey().toString("base64url") }]));
  const made = await whenStoreIsUp(w, "work.chat.create", { title, id, ring: ring.doc, people: [], agents });
  return String(made.chat || id);
}
