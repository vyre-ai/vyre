// @ts-check
// The home computer is not a row relay.devices.list returns (that list is the paired phones and the other computers). Settings, Devices shows this computer first.

/**
 * Prepend this computer when the relay's list does not already have it.
 * @param {unknown} data relay.devices.list's answer, `{ devices: [...] }`
 * @param {string} [hereId]
 */
export function withThisComputer(data, hereId = "this-computer") {
  const src = data && typeof data === "object" ? /** @type {any} */ (data) : {};
  const devices = Array.isArray(src.devices) ? src.devices : [];
  if (devices.some((/** @type {any} */ d) => d && (d.id === hereId || d.name === "This computer"))) return { ...src, devices };
  const now = Date.now();
  return { ...src, devices: [{ id: hereId, name: "This computer", kind: "app", pairedAt: now, lastSeen: now, online: true }, ...devices] };
}
