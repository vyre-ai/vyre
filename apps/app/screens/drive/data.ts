// Drive's sample data. `driveRepo` is where the real file source plugs in.
import type { SpaceId } from "../places/scope";

export type DriveFile = { id: string; sp: SpaceId; proj: string; name: string; ver: number; mod: string; by: string; att?: { id: string; title: string }; size: string; sealed?: boolean; note?: string };
export type Link = { id: string; file: string; name: string; code: string };

export const PROJECTS: Record<string, string> = { estate: "Doe estate plan", harlow: "Harlow Legal", site: "Vyre site", mine: "Personal" };
/** People and assistants that edit files, for the version lines. */
export const EDITORS = ["chris", "kit"];

export const driveRepo = {
  files(): DriveFile[] {
    return [
      { id: "d1", sp: "harlow", proj: "estate", name: "Trust agreement v4.pdf", ver: 4, mod: "Today 9:05", by: "kit", att: { id: "m4", title: "Doe trust" }, size: "184 KB" },
      { id: "d2", sp: "harlow", proj: "estate", name: "Intake questionnaire.pdf", ver: 1, mod: "8 Sep", by: "kit", att: { id: "jane", title: "Jane Doe" }, size: "96 KB" },
      { id: "d3", sp: "harlow", proj: "estate", name: "Engagement letter (signed).docx", ver: 3, mod: "Yesterday", by: "chris", att: { id: "jane", title: "Jane Doe" }, size: "58 KB" },
      { id: "d4", sp: "harlow", proj: "estate", name: "Doe will (filled).pdf", ver: 2, mod: "Today 8:50", by: "chris", att: { id: "jane", title: "Jane Doe" }, size: "212 KB", sealed: true, note: "Contains an SSN" },
      { id: "d5", sp: "harlow", proj: "harlow", name: "Weekly report template.docx", ver: 7, mod: "Fri 25 Sep", by: "juno", size: "41 KB" },
      { id: "d6", sp: "mine", proj: "site", name: "Wink page copy.md", ver: 5, mod: "Tue", by: "juno", size: "6 KB" },
      { id: "d7", sp: "mine", proj: "site", name: "Trail map.pdf", ver: 1, mod: "Sat", by: "alex", size: "2.1 MB" },
      { id: "d8", sp: "mine", proj: "mine", name: "Passport scan.pdf", ver: 1, mod: "12 Aug", by: "alex", size: "1.4 MB", sealed: true, note: "Contains a passport number" },
    ];
  },
  links(): Link[] {
    return [];
  },
  /** What the mounted drive shows in the computer's file manager. */
  mount(): { computer: string; folders: { path: string; count: string }[]; sealed: string[] } {
    return {
      computer: "Alex's Mac",
      folders: [{ path: "Mine", count: "3 files" }, { path: "Harlow Legal", count: "5 files" }, { path: "Harlow Legal / Doe estate plan", count: "4 files, 1 kept away" }],
      sealed: ["Doe will (filled).pdf"],
    };
  },
};
