// The status mark's words and numbers (status-mark spec): the elapsed time on running, when it
// next changes, and the badge's text and name. Pure, so node tests import it.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Running always carries its elapsed time: under a minute "12s", under an hour "4m", then "1h 12m"
 * ("2h" on the hour). A clock that runs behind reads 0s, never a negative.
 * @param {number} ms
 * @returns {string}
 */
export function elapsed(ms) {
  const t = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (t < MINUTE) return `${Math.floor(t / SECOND)}s`;
  if (t < HOUR) return `${Math.floor(t / MINUTE)}m`;
  const h = Math.floor(t / HOUR);
  const m = Math.floor((t % HOUR) / MINUTE);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * How long until the elapsed text changes: once a second under a minute, then once a minute,
 * timed to the boundary so the text never lags a tick.
 * @param {number} ms
 * @returns {number}
 */
export function nextTick(ms) {
  const t = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const step = t < MINUTE ? SECOND : MINUTE;
  return step - (t % step);
}

/**
 * The badge's text: 1 to 99, then "99+". The exact number stays in the page header.
 * @param {number} n
 * @returns {string}
 */
export function badgeText(n) {
  return n > 99 ? "99+" : String(Math.max(0, Math.floor(n)));
}

/**
 * The badge's accessible name: "3 need you", "1 needs you", "more than 99 need you".
 * @param {number} n
 * @returns {string}
 */
export function badgeLabel(n) {
  if (n > 99) return "more than 99 need you";
  const k = Math.max(0, Math.floor(n));
  return k === 1 ? "1 needs you" : `${k} need you`;
}
