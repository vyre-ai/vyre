// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { whenText, fromGraph, fromGoogle, upNext, requests, meetingLink, hostOf } from "./calendar.js";

const AT = Date.parse("2026-10-01T09:00:00Z");

test("whenText: relative, running and far", () => {
  assert.equal(whenText(AT + 10 * 60_000, AT + 40 * 60_000, AT), "in 10 min");
  assert.equal(whenText(AT - 5 * 60_000, AT + 20 * 60_000, AT), "now, ends in 20 min");
  assert.equal(whenText(AT + 3 * 3_600_000, AT + 4 * 3_600_000, AT), "in 3 h");
});

test("Graph: UTC times get a Z, all-day and cancelled are out, the join link is https only", () => {
  const body = { value: [
    { id: "g1", subject: "Menu call", isAllDay: false, start: { dateTime: "2026-10-01T09:30:00.0000000" }, end: { dateTime: "2026-10-01T10:00:00.0000000" },
      onlineMeeting: { joinUrl: "https://teams.example.test/l/meetup-join/abc" }, webLink: "https://outlook.example.test/event/1" },
    { id: "g2", subject: "Bakery closed", isAllDay: true, start: { dateTime: "2026-10-01T00:00:00.0000000" }, end: { dateTime: "2026-10-02T00:00:00.0000000" } },
    { id: "g3", subject: "Cancelled", isCancelled: true, start: { dateTime: "2026-10-01T11:00:00.0000000" }, end: { dateTime: "2026-10-01T12:00:00.0000000" } },
    { id: "g4", subject: "Office", start: { dateTime: "2026-10-01T12:00:00.0000000" }, end: { dateTime: "2026-10-01T13:00:00.0000000" }, location: { displayName: "javascript:alert(1)" }, webLink: "https://outlook.example.test/event/4" },
  ] };
  const ev = fromGraph(body, "microsoft");
  assert.deepEqual(ev.map(e => e.id), ["g1", "g4"]);
  assert.equal(ev[0].start, "2026-10-01T09:30:00Z");
  assert.equal(ev[0].join, "https://teams.example.test/l/meetup-join/abc");
  assert.equal(ev[0].link, ev[0].join);
  assert.equal(ev[1].join, undefined, "a location that is not an https link is not a join link");
  assert.equal(ev[1].link, "https://outlook.example.test/event/4");
  assert.deepEqual(fromGraph(null, "m"), []);
});

test("Google: hangout, conference and https locations join; cancelled and all-day are out", () => {
  const body = { items: [
    { id: "a", summary: "Kit", status: "confirmed", hangoutLink: "https://meet.example.test/x", start: { dateTime: "2026-10-01T10:00:00Z" }, end: { dateTime: "2026-10-01T10:30:00Z" } },
    { id: "b", summary: "Conf", conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:1" }, { entryPointType: "video", uri: "https://zoom.example.test/j/1" }] }, start: { dateTime: "2026-10-01T11:00:00Z" } },
    { id: "c", summary: "Gone", status: "cancelled", start: { dateTime: "2026-10-01T12:00:00Z" } },
    { id: "d", summary: "All day", start: { date: "2026-10-01" } },
  ] };
  const ev = fromGoogle(body, "personal");
  assert.deepEqual(ev.map(e => [e.id, e.join]), [["a", "https://meet.example.test/x"], ["b", "https://zoom.example.test/j/1"]]);
});

test("upNext merges and orders across calendars, drops what has ended, cuts to the limit", () => {
  const ev = [
    { id: "late", title: "Late", start: "2026-10-01T15:00:00Z", end: "2026-10-01T16:00:00Z", link: "" },
    { id: "gone", title: "Gone", start: "2026-10-01T07:00:00Z", end: "2026-10-01T08:00:00Z", link: "" },
    { id: "now", title: "Now", start: "2026-10-01T08:45:00Z", end: "2026-10-01T09:30:00Z", link: "" },
    { id: "soon", title: "Soon", start: "2026-10-01T09:10:00Z", end: "2026-10-01T09:40:00Z", link: "" },
  ];
  const r = upNext(ev, AT, 2);
  assert.deepEqual(r.map(e => [e.id, e.when]), [["now", "now, ends in 30 min"], ["soon", "in 10 min"]]);
});

test("the two requests read a calendar only and name the paths the reader is given", () => {
  const r = requests("2026-10-01T09:00:00.000Z", "2026-10-01T23:59:59.999Z");
  assert.equal(r.graph.method, "GET");
  assert.equal(new URL(r.graph.url).pathname, "/v1.0/me/calendarView");
  assert.equal(new URL(r.google.url).pathname, "/calendar/v3/calendars/primary/events");
});

test("a location is a join link only on a known meeting host; the host is shown; declined events are skipped", () => {
  assert.equal(meetingLink("https://us02web.zoom.us/j/123"), "https://us02web.zoom.us/j/123");
  assert.equal(meetingLink("https://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij");
  assert.equal(meetingLink("https://teams.microsoft.com/l/meetup-join/x"), "https://teams.microsoft.com/l/meetup-join/x");
  assert.equal(meetingLink("https://acme.webex.com/meet/kit"), "https://acme.webex.com/meet/kit");
  for (const bad of ["https://evil.example/zoom.us", "https://zoom.us.evil.example/j/1", "https://notzoom.us/j/1", "http://zoom.us/j/1", "javascript:alert(1)", "Zoom", "", undefined]) assert.equal(meetingLink(bad), "", String(bad));
  assert.equal(hostOf("https://Meet.Google.com/x"), "meet.google.com");
  assert.equal(hostOf("http://a.test"), "");

  const g = fromGoogle({ items: [
    { id: "p", summary: "Phish", location: "https://evil.example.test/login", start: { dateTime: "2026-10-01T10:00:00Z" } },
    { id: "d", summary: "Declined", hangoutLink: "https://meet.google.com/x", attendees: [{ self: true, responseStatus: "declined" }], start: { dateTime: "2026-10-01T10:00:00Z" } },
    { id: "m", summary: "Meet", hangoutLink: "https://meet.google.com/ok", attendees: [{ self: true, responseStatus: "accepted" }], start: { dateTime: "2026-10-01T10:10:00Z" } },
  ] }, "p");
  assert.deepEqual(g.map(e => [e.id, e.join]), [["p", undefined], ["m", "https://meet.google.com/ok"]]);
  const gr = fromGraph({ value: [{ id: "x", subject: "Declined", responseStatus: { response: "declined" }, start: { dateTime: "2026-10-01T10:00:00.0" } }] }, "m");
  assert.deepEqual(gr, []);
  const rows = upNext(fromGoogle({ items: [{ id: "m", summary: "Meet", hangoutLink: "https://meet.google.com/ok", start: { dateTime: "2026-10-01T09:10:00Z" }, end: { dateTime: "2026-10-01T09:40:00Z" } }] }, "p"), AT, 3);
  assert.equal(rows[0].when, "in 10 min · meet.google.com");
});
