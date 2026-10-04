// Gives the generated screens their Store: the vyred the app is paired with, through the box connection (src/api/box), one tool call per Store method.
// Imported once by the /u layout, before any screen asks for a Store. The mock exists only in a build made with EXPO_PUBLIC_VYRE_MOCK=1 (deck/ui/store.js).
import { allowMock, setStore } from "../../../../deck/ui/store.js";
import { createGatewayStore, storeError } from "../../../../deck/ui/gateway-adapter.js";
import { call, listen, send } from "./box";

(globalThis as { __VYRE_APP__?: boolean }).__VYRE_APP__ = true;

/** The box connection as the adapter's rpc: reads now, writes through the outbox, a human-only call's proof as the call's presence. */
export const boxRpc = {
  async read(tool: string, input: Record<string, unknown> = {}) {
    const r = await call(tool, input);
    if (r.error) throw storeError(r.error);
    return r.data;
  },
  async write(tool: string, input: Record<string, unknown> = {}, o: { proof?: unknown } = {}) {
    const s = await send(tool, input, typeof o.proof === "string" ? { presence: o.proof } : {});
    const r = await s.answered;
    if (r.error) throw storeError(r.error);
    return r.data;
  },
  events: (on: (e: unknown) => void) => listen(on as never),
};

if (process.env.EXPO_PUBLIC_VYRE_MOCK === "1") allowMock();
else setStore(createGatewayStore({ rpc: boxRpc as never }));
