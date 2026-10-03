// @ts-check
// /u/task: owned by the UI build (docs/work/native-core.md). Replace this stub.
import { h, put } from "../js/dom.js";

/** @param {any} ctx */
export default function screen(ctx) { put(ctx.root, h("div", { class: "ui-empty" }, h("b", null, "task"), h("p", null, "Not built yet."))); }
