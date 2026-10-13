// @ts-check
// What the instructions editor and its preview decide about a reference (lib/doc-refs.js): the icon for its kind, and the page that opens it. Pure.
import { kindOf } from "../../../../lib/doc-refs.js";

/** The icon name for a reference by its kind. @param {"@" | "#"} lead @param {string} kind */
export function refIcon(lead, kind) {
  if (kind === "person") return "person";
  if (kind === "role" || kind === "team") return "users";
  if (kind === "agent") return "agents";
  if (kind === "project") return "projects";
  if (kind === "file" || kind === "linked") return "file";
  if (kind === "folder") return "drive";
  if (kind === "tag") return "hash";
  if (kind === "record" || kind === "type" || kind === "template") return "records";
  return lead === "@" ? "mention" : "hash";
}

/**
 * The page a reference opens, as an app route. A person has no page of their own yet, so it opens the Space's people (Roles); a record opens its type's list; a file opens Files.
 * @param {string} urn @returns {string}
 */
export function refRoute(urn) {
  const m = /^vyre:\/\/[^/]+\/([^/]+)(?:\/(.*))?$/.exec(urn);
  if (!m) return "/u/now";
  const kind = kindOf(urn), rest = m[2] ?? "";
  const dec = (/** @type {string} */ s) => { try { return decodeURIComponent(s); } catch { return s; } };
  if (kind === "agent") return `/u/assistants/${encodeURIComponent(dec(rest))}`;
  if (kind === "project") return `/u/project/${encodeURIComponent(dec(rest))}`;
  if (kind === "tag") return `/u/tags/${encodeURIComponent(dec(rest))}`;
  if (kind === "person" || kind === "role" || kind === "team") return "/u/settings/roles";
  if (kind === "file" || kind === "linked" || kind === "folder") return "/u/files";
  if (kind === "type" || kind === "template") return kind === "type" ? `/u/records/${encodeURIComponent(dec(rest))}` : "/u/playbooks";
  return `/u/records/${encodeURIComponent(dec(m[1]))}`;
}
