// @ts-check
// sse: frames from a server-sent-events buffer that may end mid-frame. The same rules as the
// browser's EventSource: a blank line ends a frame, ":" starts a comment, several data lines join
// with "\n", and an `id:` with no data still moves the cursor (vyred sends one on open and with
// every heartbeat, ADR 0029 R1).

/**
 * @param {string} buffer
 * @returns {{ frames: { id: string|null, event: string|null, data: string, retry: number|null }[], rest: string }}
 */
export function parse(buffer) {
  // A chunk that ends in "\r" may be half of a "\r\n": keep it back until the next chunk says,
  // or the pair would read as a blank line and end the frame early.
  const whole = String(buffer);
  const held = whole.endsWith("\r") ? "\r" : "";
  const parts = (held ? whole.slice(0, -1) : whole).replace(/\r\n?/g, "\n").split("\n\n");
  const rest = (parts.pop() ?? "") + held;
  const frames = [];
  for (const block of parts) {
    let id = null, event = null, retry = null, any = false;
    const data = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const at = line.indexOf(":");
      const field = at === -1 ? line : line.slice(0, at);
      let value = at === -1 ? "" : line.slice(at + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") { id = value; any = true; }
      else if (field === "event") { event = value; any = true; }
      else if (field === "data") { data.push(value); any = true; }
      else if (field === "retry" && /^\d+$/.test(value)) { retry = Number(value); any = true; }
    }
    if (any) frames.push({ id, event, data: data.join("\n"), retry });
  }
  return { frames, rest };
}
