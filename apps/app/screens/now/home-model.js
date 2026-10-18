// The top of Home: the date, the greeting by the person's local time, and a one-line summary of what needs them. Pure (home-model.test.js).

/** The part of the day on the person's own clock. @param {number} hour 0 to 23 */
export const partOfDay = (hour) => (hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night");

/** "Good morning, Alex." A late-night hour says "Still up, Alex." The name is left out when unknown. @param {number} hour @param {string} [name] */
export function greeting(hour, name) {
  const who = name && name.trim() ? `, ${name.trim().split(/\s+/)[0]}` : "";
  const p = partOfDay(hour);
  return p === "night" ? `Still up${who}.` : `Good ${p}${who}.`;
}

/** The date line, "Sunday, 18 October". @param {number} at ms @param {string} [zone] */
export const dateLine = (at, zone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", ...(zone ? { timeZone: zone } : {}) }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return `${p.weekday}, ${p.day} ${p.month}`;
};

/** One sentence: what waits on the person, what is working, what is on today. @param {{ waiting?: number, working?: number, today?: number }} n */
export function summary(n) {
  const w = n.waiting ?? 0, k = n.working ?? 0, t = n.today ?? 0;
  const bits = [];
  if (w) bits.push(`${w} ${w === 1 ? "thing needs" : "things need"} you`);
  if (k) bits.push(`${k} ${k === 1 ? "agent is" : "agents are"} working`);
  if (t) bits.push(`${t} on today`);
  return bits.length ? `${bits.join(", ")}.` : "Nothing needs you right now.";
}
