// The screens' sources take a `call` that answers { data } or { error }. This one goes through tool(), so an ask for the person's own proof is answered the way this build does it:
// the phone with its biometric, the web with "Approve on your phone" (a kernel act the approvals route covers) or "Do this in Vyre on your phone". A plain call would show the raw refusal.
import { tool } from "./box";

export async function callT<T = unknown>(name: string, input: Record<string, unknown> = {}): Promise<{ data?: T; error?: { code: string; message: string } }> {
  try { return { data: await tool<T>(name, input) }; }
  catch (e) { const x = e as { code?: string; message?: string }; return { error: { code: x.code ?? "error", message: x.message ?? "" } }; }
}
