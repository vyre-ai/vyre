// @ts-check
// Weather over a fake fetch: the place, the URLs, which day of the forecast, the words, and a
// network failure as code failed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./env.js";
import { fakeExec, fakeFetch } from "./fake.js";
import weather, { words, cityOf } from "./adapters/weather.js";

const GEO = { results: [{ name: "Kuala Lumpur", latitude: 3.14, longitude: 101.69, country: "Malaysia" }] };
const FORECAST = {
  current: { temperature_2m: 29.6, weather_code: 2 },
  daily: {
    time: ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"],
    weather_code: [2, 63, 95, 0, 45, 71, 81],
    temperature_2m_max: [32.4, 31.2, 30, 33, 29, 28, 30],
    temperature_2m_min: [24.6, 23.8, 24, 25, 23, 22, 23],
    precipitation_probability_max: [20, 80, 90, 0, 10, 30, 60],
  },
};

const envWith = (/** @type {any} */ routes, extra = {}) => {
  const f = fakeFetch(routes);
  return { env: makeEnv({ config: { exec: fakeExec().exec, platform: "darwin", fetch: f.fetch, timeZone: "Asia/Kuala_Lumpur", ...extra } }), urls: f.urls };
};

test("weather: WMO codes read as short words, and a zone names its city", () => {
  assert.deepEqual([0, 2, 3, 45, 53, 65, 73, 81, 86, 96].map(words),
    ["clear", "partly cloudy", "cloudy", "fog", "drizzle", "rain", "snow", "showers", "snow", "thunderstorm"]);
  assert.equal(cityOf("Asia/Kuala_Lumpur"), "Kuala Lumpur");
  assert.equal(cityOf("America/Argentina/Buenos_Aires"), "Buenos Aires");
  assert.equal(cityOf("UTC"), "");
});

test("weather: tomorrow takes daily[1], from the time zone's city by default", async () => {
  const w = envWith({ "geocoding-api": GEO, "api.open-meteo.com/v1/forecast": FORECAST });
  const r = await weather.actions.get.run({ day: "tomorrow" }, w.env);
  assert.equal(r.said, "Tomorrow in Kuala Lumpur: rain, 31 / 24 C, 80% chance of rain");
  assert.deepEqual({ place: r.place, day: r.day, high: r.high, low: r.low, rainChance: r.rainChance, words: r.words },
    { place: "Kuala Lumpur", day: "2026-09-28", high: 31, low: 24, rainChance: 80, words: "rain" });
  assert.equal(w.urls[0], "https://geocoding-api.open-meteo.com/v1/search?name=Kuala%20Lumpur&count=1");
  assert.equal(w.urls[1], "https://api.open-meteo.com/v1/forecast?latitude=3.14&longitude=101.69&current=temperature_2m,weather_code"
    + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7");
});

test("weather: today includes the current temperature; a date names its weekday; fahrenheit asks for it", async () => {
  const w = envWith({ "geocoding-api": GEO, "forecast": FORECAST }, { weather: { place: "Harlow", units: "f" } });
  const today = await weather.actions.get.run({}, w.env);
  assert.equal(today.said, "Today in Kuala Lumpur: partly cloudy, 32 / 25 F, 20% chance of rain");
  assert.equal(today.current, 30);
  assert.match(w.urls[0], /name=Harlow&/);
  assert.match(w.urls[1], /&temperature_unit=fahrenheit$/);
  const fri = await weather.actions.get.run({ place: "Kuala Lumpur", day: "2026-10-02" }, w.env);
  assert.equal(fri.said, "Friday 2 Oct in Kuala Lumpur: snow, 28 / 22 F, 30% chance of rain");
  await assert.rejects(weather.actions.get.run({ day: "2026-12-25" }, w.env), (/** @type {any} */ e) => e.code === "bad_input");
  await assert.rejects(weather.actions.get.run({ day: "next week" }, w.env), (/** @type {any} */ e) => e.code === "bad_input");
});

test("weather: a network failure or a bad status is code failed in words; an unknown place is not_found", async () => {
  const down = envWith({ "geocoding-api": new Error("getaddrinfo ENOTFOUND") });
  await assert.rejects(weather.actions.get.run({}, down.env), (/** @type {any} */ e) => e.code === "failed" && /could not reach the weather service: getaddrinfo/.test(e.message));
  const busy = envWith({ "geocoding-api": GEO, "forecast": { status: 503 } });
  await assert.rejects(weather.actions.get.run({}, busy.env), (/** @type {any} */ e) => e.code === "failed" && /503/.test(e.message));
  const nowhere = envWith({ "geocoding-api": { results: [] } });
  await assert.rejects(weather.actions.get.run({ place: "Atlantis" }, nowhere.env), (/** @type {any} */ e) => e.code === "not_found");
  const utc = envWith({}, { timeZone: "UTC" });
  await assert.rejects(weather.actions.get.run({}, utc.env), (/** @type {any} */ e) => e.code === "bad_input");
});

test("weather: open runs open -a Weather through exec", async () => {
  const f = fakeExec();
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  assert.equal((await weather.actions.open.run({}, env)).said, "Opened Weather");
  assert.deepEqual(f.calls, [{ file: "open", args: ["-a", "Weather"], opts: {} }]);
});
