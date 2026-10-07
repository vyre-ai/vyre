// @ts-check
// Gmail, as a declaration (records/connectors/format.js). Reading is a read. A draft is prepared in the mailbox and a person sends it there: it is not outward. A send is outward and
// held. The poll lists new messages and reads each one's headers, and the mapping turns it into the item the "Log communications" Flow files (records/comms/log-flow.js).
import { defineConnector } from "../format.js";

const READ = "https://www.googleapis.com/auth/gmail.readonly", COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID"];
const H = (/** @type {string} */ n) => `payload.headers[name=${n}].value`;

export default defineConnector({
  id: "gmail", label: "Gmail", version: 1,
  base_url: "https://gmail.googleapis.com",
  auth: { type: "google", scopes: [READ, COMPOSE] },
  // Gmail's own cap is far above this; it is a Space-wide ceiling so one busy Flow cannot starve the others.
  rate: { per_minute: 600, retry_after: true },
  ops: {
    "profile.get": { method: "GET", path: "/gmail/v1/users/me/profile", kind: "read", label: "The mailbox's own address", output: { emailAddress: { type: "string", required: true } } },
    "messages.list": { method: "GET", path: "/gmail/v1/users/me/messages", kind: "read", label: "List messages",
      input: { query: { q: { type: "string", max: 500 }, maxResults: { type: "number" }, pageToken: { type: "string" }, labelIds: { type: "array", items: { type: "string" } } } },
      output: { messages: { type: "array" } } },
    "messages.get": { method: "GET", path: "/gmail/v1/users/me/messages/{id}", kind: "read", label: "Read one message",
      input: { params: { id: { type: "string", required: true } }, query: { format: { type: "string", enum: ["metadata", "minimal", "full"] }, metadataHeaders: { type: "array", items: { type: "string" } } } },
      output: { id: { type: "string", required: true }, threadId: { type: "string" } } },
    "threads.get": { method: "GET", path: "/gmail/v1/users/me/threads/{id}", kind: "read", label: "Read a thread",
      input: { params: { id: { type: "string", required: true } }, query: { format: { type: "string", enum: ["metadata", "minimal", "full"] } } }, output: { id: { type: "string", required: true } } },
    // A draft is made in the mailbox for a person to read and send there. The body is the raw message, wrapped as Gmail's draft resource wants: { message: { raw } }.
    "drafts.create": { method: "POST", path: "/gmail/v1/users/me/drafts", kind: "draft", wrap: "message", label: "Prepare a draft",
      input: { body: { raw: { type: "string", required: true, max: 5_000_000 }, threadId: { type: "string" } } }, output: { id: { type: "string", required: true } } },
    "messages.send": { method: "POST", path: "/gmail/v1/users/me/messages/send", kind: "send", label: "Send an email",
      input: { body: { raw: { type: "string", required: true, max: 5_000_000 }, threadId: { type: "string" } } }, output: { id: { type: "string", required: true } },
      readback: { op: "messages.get", args: { id: "response.json.id" } } },
    "drafts.send": { method: "POST", path: "/gmail/v1/users/me/drafts/send", kind: "send", label: "Send a draft",
      input: { body: { id: { type: "string", required: true } } }, output: { id: { type: "string", required: true } } },
  },
  poll: {
    "mail.recent": {
      op: "messages.list", items: "messages", id: "id", every_minutes: 5, label: "New mail",
      args: { query: { q: "after:{since_s}", maxResults: "50" } },
      expand: { op: "messages.get", args: { id: "id" }, query: { format: "metadata", metadataHeaders: HEADERS } },
      map: {
        comm_kind: { const: "email" },
        source_key: { template: "gmail:{$mailbox}:{id}" },
        mailbox: "$mailbox",
        direction: { direction: { from: H("From"), mine: "$mailbox" } },
        at: "internalDate|iso",
        title: `${H("Subject")}|truncate:300`,
        subject: `${H("Subject")}|truncate:300`,
        excerpt: "snippet|truncate:300",
        thread: "threadId",
        original_url: { template: "https://mail.google.com/mail/u/{$mailbox}/#all/{id}" },
        people: { people: [{ path: H("From"), how: "from" }, { path: H("To"), how: "to" }, { path: H("Cc"), how: "cc" }] },
      },
    },
  },
});
