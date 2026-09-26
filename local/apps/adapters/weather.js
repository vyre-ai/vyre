// @ts-check
// weather: the forecast, from Open-Meteo rather than the Weather app.
//
// Weather has no AppleScript and no App Intent that returns a forecast, and WeatherKit needs an
// Apple developer key. Open-Meteo is free, needs no key and sends back JSON, so "weather
// tomorrow" is two HTTP calls (find the place, then its forecast) and no app opens. `open` brings
// up the Weather app itself for a person who wants the full view.
//
// The place is the one asked for, else config apps.weather.place, else the city in the system
// time zone ("Asia/Kuala_Lumpur" is Kuala Lumpur), which is right for most people most days.

import { AppsError } from "../env.js";

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

/** WMO weather interpretation codes, as a few short words. */
export function words(/** @type {number} */ code) {
  if (code === 0) return "clear";
  if (code === 1 || code === 2) return "partly cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code === 85 || code === 86) return "snow";
  if (code >= 95 && code <= 99) return "thunderstorm";
  return "unknown";
}

/** The IANA areas whose zones are named after a city. Etc/, US/ and the rest are not. */
const AREAS = new Set(["Africa", "America", "Antarctica", "Asia", "Atlantic", "Australia", "Europe", "Indian", "Pacific"]);

/**
 * The city in an IANA time zone name: "America/Argentina/Buenos_Aires" -> "Buenos Aires". "" for
 * a zone that names no city ("UTC", "Etc/GMT+8", "US/Pacific") or does not parse.
 */
export function cityOf(/** @type {string} */ tz) {
  const parts = String(tz || "").split("/");
  if (parts.length < 2 || !AREAS.has(parts[0])) return "";
  const city = parts[parts.length - 1];
  return /^[A-Za-z][A-Za-z_'-]*$/.test(city) ? city.replace(/_/g, " ") : "";
}

/** How long each request to the weather service may take. */
export const FETCH_TIMEOUT_MS = 10000;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-02" -> "Friday 2 Oct", read as a calendar date, not a moment, so no zone shifts it. */
function dateWords(/** @type {string} */ ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** GET JSON, with any failure as code failed in words. */
async function getJson(/** @type {any} */ env, /** @type {string} */ url) {
  let res;
  try { res = await env.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); }
  catch (e) {
    const err = /** @type {Error} */ (e);
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new AppsError("failed", `the weather service did not answer within ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw new AppsError("failed", `could not reach the weather service: ${err.message}`);
  }
  if (!res || !res.ok) throw new AppsError("failed", `the weather service answered ${res ? res.status : "nothing"}`);
  try { return await res.json(); }
  catch { throw new AppsError("failed", "the weather service sent something that is not JSON"); }
}

/** @type {import("./index.js").Adapter} */
export default {
  id: "weather",
  app: "Weather",
  bundleIds: ["com.apple.weather"],
  tier: "connector",
  actions: {
    get: {
      title: "The forecast",
      input: { type: "object", properties: {
        place: { type: "string", description: "A city or town. Default: config apps.weather.place, else the time zone's city." },
        day: { type: "string", description: "today, tomorrow or YYYY-MM-DD within the next 7 days. Default today." },
      } },
      sends: false,
      async run({ place, day = "today" }, env) {
        const opts = (env.config && env.config.weather) || {};
        const where = String(place || opts.place || cityOf(env.timeZone)).trim();
        if (!where) throw new AppsError("setup", "set a place: vyre apps weather in <city>, or config apps.weather.place");
        if (day !== "today" && day !== "tomorrow" && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          throw new AppsError("bad_input", `day must be today, tomorrow or YYYY-MM-DD, not "${day}"`);
        }
        const geo = await getJson(env, `${GEO}?name=${encodeURIComponent(where)}&count=1`);
        const hit = geo && Array.isArray(geo.results) && geo.results[0];
        if (!hit) throw new AppsError("not_found", `no place called ${where}`);
        const f = opts.units === "f";
        const fc = await getJson(env, `${FORECAST}?latitude=${hit.latitude}&longitude=${hit.longitude}`
          + "&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
          + `&timezone=auto&forecast_days=7${f ? "&temperature_unit=fahrenheit" : ""}`);
        const daily = fc && fc.daily;
        if (!daily || !Array.isArray(daily.time)) throw new AppsError("failed", "the weather service sent no forecast");
        const i = day === "today" ? 0 : day === "tomorrow" ? 1 : daily.time.indexOf(day);
        if (i < 0 || i >= daily.time.length) throw new AppsError("bad_input", `the forecast covers ${daily.time[0]} to ${daily.time[daily.time.length - 1]}`);
        const round = (/** @type {any} */ n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);
        const at = (/** @type {string} */ k) => (Array.isArray(daily[k]) ? round(daily[k][i]) : null);
        const high = at("temperature_2m_max"), low = at("temperature_2m_min"), code = at("weather_code");
        // Open-Meteo sends null for a value it has no model for; a forecast without its
        // numbers is no forecast. Rain chance alone may be missing and is then left out.
        if (high === null || low === null || code === null) throw new AppsError("failed", `the weather service has no forecast for ${hit.name} on ${daily.time[i]}`);
        const rainChance = at("precipitation_probability_max");
        const w = words(code);
        const unit = f ? "F" : "C";
        const label = day === "today" ? "Today" : day === "tomorrow" ? "Tomorrow" : dateWords(daily.time[i]);
        const current = i === 0 && fc.current ? round(fc.current.temperature_2m) : null;
        const said = `${label} in ${hit.name}: ${w}, ${high} / ${low} ${unit}${rainChance === null ? "" : `, ${rainChance}% chance of rain`}`;
        return { said, place: hit.name, day: daily.time[i], high, low, rainChance, words: w, unit, ...(current === null ? {} : { current }) };
      },
    },
    open: {
      title: "Open Weather",
      input: { type: "object", properties: {} },
      sends: false,
      async run(_args, env) {
        await env.open("Weather");
        return { said: "Opened Weather" };
      },
    },
  },
};
