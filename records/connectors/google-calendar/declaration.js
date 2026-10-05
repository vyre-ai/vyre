// @ts-check
// Google Calendar, as a declaration (records/connectors/format.js). Reading events is a read. Writing one is outward: the invitation reaches other people. The poll lists events changed
// since the last look and maps each to a meeting for the "Log communications" Flow; the Space's own calendar sync (records/calendar/sync.js) uses the same ops.
import { defineConnector } from "../format.js";

const EVENTS = "https://www.googleapis.com/auth/calendar.events", READ = "https://www.googleapis.com/auth/calendar.readonly";
const eventBody = {
  id: { type: "string" },
  summary: { type: "string", max: 1024 }, location: { type: "string" }, description: { type: "string" },
  start: { type: "object", required: true }, end: { type: "object", required: true }, attendees: { type: "array" },
};

export default defineConnector({
  id: "google-calendar", label: "Google Calendar", version: 1,
  base_url: "https://www.googleapis.com",
  auth: { type: "oauth", authorize_uri: "https://accounts.google.com/o/oauth2/v2/auth", token_uri: "https://oauth2.googleapis.com/token", scopes: [READ, EVENTS], also: ["service-account"] },
  rate: { per_minute: 600, retry_after: true },
  // Google Calendar takes no idempotency header: a repeated insert is stopped by the ledger and the read-back, not by the service.
  ops: {
    "events.list": { method: "GET", path: "/calendar/v3/calendars/{calendar}/events", kind: "read", label: "List events",
      input: { params: { calendar: { type: "string", required: true } },
        query: { updatedMin: { type: "time" }, timeMin: { type: "time" }, timeMax: { type: "time" }, singleEvents: { type: "string" }, showDeleted: { type: "string" }, syncToken: { type: "string" }, pageToken: { type: "string" }, maxResults: { type: "number" }, orderBy: { type: "string" } } },
      output: { items: { type: "array" } } },
    "events.get": { method: "GET", path: "/calendar/v3/calendars/{calendar}/events/{id}", kind: "read", label: "Read one event",
      input: { params: { calendar: { type: "string", required: true }, id: { type: "string", required: true } } }, output: { id: { type: "string", required: true } } },
    "events.insert": { method: "POST", path: "/calendar/v3/calendars/{calendar}/events", kind: "send", label: "Add an event",
      input: { params: { calendar: { type: "string", required: true } }, body: eventBody }, output: { id: { type: "string", required: true } },
      readback: { op: "events.get", args: { calendar: "request.params.calendar", id: "response.json.id" }, compare: { summary: "request.body.summary" } } },
    "events.patch": { method: "PATCH", path: "/calendar/v3/calendars/{calendar}/events/{id}", kind: "send", label: "Change an event",
      input: { params: { calendar: { type: "string", required: true }, id: { type: "string", required: true } }, headers: { "if-match": { type: "string" } }, body: Object.fromEntries(Object.entries(eventBody).map(([k, v]) => [k, { ...v, required: false }])) }, output: { id: { type: "string", required: true } },
      readback: { op: "events.get", args: { calendar: "request.params.calendar", id: "request.params.id" }, compare: { summary: "request.body.summary" } } },
    "events.delete": { method: "DELETE", path: "/calendar/v3/calendars/{calendar}/events/{id}", kind: "delete", label: "Remove an event",
      input: { params: { calendar: { type: "string", required: true }, id: { type: "string", required: true } } } },
  },
  poll: {
    "events.changed": {
      op: "events.list", items: "items", id: { template: "{id}:{updated}" }, every_minutes: 15, label: "New or changed events",
      args: { params: { calendar: "$calendar" }, query: { updatedMin: "{since_iso}", singleEvents: "true", maxResults: "100" } },
      map: {
        comm_kind: { const: "meeting" },
        source_key: { template: "gcal:{$calendar}:{id}" },
        at: "start.dateTime ?? start.date|iso",
        title: "summary|truncate:300",
        subject: "summary|truncate:300",
        excerpt: "description|truncate:300",
        original_url: "htmlLink",
        people: { people: [{ path: "organizer", how: "organizer" }, { path: "attendees", how: "attendee" }] },
      },
    },
  },
});
