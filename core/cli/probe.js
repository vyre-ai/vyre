// @ts-check
// probe: does a Vyre box answer at this https address? One read of its health, a few seconds, no retry. Resolves to its health, or null.

export async function probe(address, ms = 4000) {
  try {
    const r = await fetch(address.replace(/\/$/, "") + "/v1/health", { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.data ? j.data : j;
  } catch { return null; }
}
