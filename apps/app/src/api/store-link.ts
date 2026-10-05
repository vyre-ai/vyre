// Gives the generated screens their Store: the vyred the app is paired with, through the box connection (src/api/box), one tool call per Store method.
// Imported once by the /u layout, before any screen asks for a Store. The mock exists only in a build made with EXPO_PUBLIC_VYRE_MOCK=1 (deck/ui/store.js).
import { allowMock, setStore } from "../vendor/deck/ui/store.js";
import { createGatewayStore, storeError } from "../vendor/deck/ui/gateway-adapter.js";
import { call, listen, send } from "./box";
import { tool as heldTool } from "../real/box";
import { withSpace } from "../real/with-space.js";
import { useSpaces } from "../../screens/shell/state";

/** Every record, task, rule and files call names the space: the one the Store gave, else the one showing. */
const named = (tool: string, input: Record<string, unknown>) => withSpace(tool, input, useSpaces.getState().space);

(globalThis as { __VYRE_APP__?: boolean }).__VYRE_APP__ = true;

/** The calls that touch a sealed value: held for the owner's yes. */
const HELD = new Set(["records.seal-put", "records.reveal"]);

/** The box connection as the adapter's rpc: reads now, writes through the outbox, a human-only call's proof as the call's presence. */
export const boxRpc = {
  async read(tool: string, input: Record<string, unknown> = {}) {
    const r = await call(tool, named(tool, input));
    if (r.error) throw storeError(r.error);
    return r.data;
  },
  async write(tool: string, input: Record<string, unknown> = {}, o: { proof?: unknown } = {}) {
    // A sealed value is filled or shown only after the owner's yes: the box holds the call, the phone answers, and the call goes again with the approval (src/real/box.ts).
    if (HELD.has(tool) && typeof o.proof !== "string") {
      try { return await heldTool(tool, named(tool, input)); } catch (e) { const x = e as { code?: string; message?: string }; throw storeError({ code: x.code, message: x.message }); }
    }
    const s = await send(tool, named(tool, input), typeof o.proof === "string" ? { presence: o.proof } : {});
    const r = await s.answered;
    if (r.error) throw storeError(r.error);
    return r.data;
  },
  events: (on: (e: unknown) => void) => listen(on as never),
};

if (process.env.EXPO_PUBLIC_VYRE_MOCK === "1") allowMock();
else setStore(createGatewayStore({ rpc: boxRpc as never }));
