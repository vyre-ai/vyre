import { callT as call } from "../../src/real/call-tool";
import { inputOf, type Change } from "./model";

/** The audit on the real box: who changed what, newest first. Owners and admins only; the box says so to anyone else. */
export async function auditReal(filters: { person?: string; project?: string; type?: string; record?: string }): Promise<{ changes: Change[]; more: boolean }> {
  const r = await call<{ changes?: Change[]; more?: boolean }>("records.audit", inputOf(filters));
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return { changes: r.data?.changes ?? [], more: Boolean(r.data?.more) };
}
