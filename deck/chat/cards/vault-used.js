// @ts-check
// The quiet line under a turn that used a vault item: "using #GHLapikey", with the host it went to. A row,
// not a card: nothing waits on it and it is never a prompt (a use is not a reveal, and the person's own
// turn asked for it). The value is never here, only the name. Data, from the vault.used event:
// { thread, name, host?, at? }.

import { h } from "../../js/dom.js";
import { icon } from "../../js/icons.js";
import { ensureCss } from "./kit.js";

/** @param {{ name: string, host?: string|null, at?: number|null }} data @returns {HTMLElement} */
export function vaultUsed(data) {
  ensureCss("vault-used");
  const el = /** @type {any} */ (h("div", { class: "cv-row cv-using", role: "status" },
    h("span", { class: "cv-using-ico", "aria-hidden": "true" }, icon("key", 12)),
    h("span", { class: "cv-using-line ellipsis" }, "using ", h("b", null, "#" + String(data?.name ?? "")), data?.host ? h("span", { class: "faint" }, " · " + String(data.host)) : null)));
  el._kind = "assistant";
  el._ts = data?.at ?? null;
  return el;
}
