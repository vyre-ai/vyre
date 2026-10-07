// Memory's sample data: the public sample world (alex, Juniper Studio, juno, kit, Jane Doe). `memoryRepo` is the one place a real source replaces.
import type { SpaceId } from "../places/scope";

export type FactSource = { kind: "record" | "file" | "chat" | "email" | "flow"; label: string; target?: string };
export type Fact = { id: string; sp: SpaceId; subj: string; kind: "person" | "project" | "space"; text: string; src: FactSource; by: string; when: string; used: number };

export const SUBJECTS: Record<string, string> = { jane: "Jane Doe", marcus: "Marcus Doe", estate: "Doe estate plan", juniper: "Juniper Studio", sam: "Sam", site: "Vyre site", alex: "Alex" };

/** Sealed fields Memory never reads, by who they belong to. */
export type SealedNote = { subject: string; space: SpaceId; labels: string[] };

const f = (id: string, sp: SpaceId, subj: string, kind: Fact["kind"], text: string, src: FactSource, by: string, when: string, used: number): Fact => ({ id, sp, subj, kind, text, src, by, when, used });

export const memoryRepo = {
  facts(): Fact[] {
    return [
      f("f1", "juniper", "jane", "person", "Wants the trust funded before the house sale in November.", { kind: "record", label: "Jane Doe, Notes", target: "record/jane" }, "kit", "8 Sep", 6),
      f("f2", "juniper", "jane", "person", "Widowed, with two adult children.", { kind: "file", label: "Intake questionnaire.pdf" }, "kit", "8 Sep", 3),
      f("f3", "juniper", "jane", "person", "Prefers email to phone calls.", { kind: "chat", label: "Intake follow-up", target: "chat/t1" }, "juno", "Today", 2),
      f("f4", "juniper", "jane", "person", "Marcus Doe is her successor trustee.", { kind: "record", label: "Doe trust, Marcus", target: "record/m4" }, "kit", "Mon 28 Sep", 4),
      f("f5", "juniper", "marcus", "person", "Lives in Berkeley and is only free on Thursdays.", { kind: "email", label: "Email from Marcus Doe" }, "juno", "21 Sep", 1),
      f("f6", "juniper", "estate", "project", "The engagement letter uses firm template v3 with fee schedule B.", { kind: "file", label: "Engagement letter (signed).docx" }, "kit", "Yesterday", 5),
      f("f7", "juniper", "juniper", "project", "The weekly report goes out Friday before noon, PDFs named by matter number.", { kind: "chat", label: "Juniper Studio brief", target: "chat/brief" }, "juno", "12 Aug", 12),
      f("f8", "juniper", "juniper", "project", "Dana Reyes is the client contact.", { kind: "email", label: "Email from Dana Reyes" }, "juno", "12 Aug", 9),
      f("f9", "juniper", "juniper", "space", "Notarization is done by Lena Ortiz, same day.", { kind: "record", label: "Lena Ortiz", target: "record/lena" }, "kit", "30 Jul", 3),
      f("f10", "juniper", "juniper", "space", "An attorney approves every letter before it is sent.", { kind: "record", label: "Engagement letter template", target: "record/tpl2" }, "kit", "3 Sep", 14),
      f("f11", "mine", "sam", "person", "Saturday hike, 8 am at the trailhead.", { kind: "chat", label: "Reply to Sam" }, "juno", "Today", 1),
      f("f12", "mine", "site", "project", "The Vyre site launches with the Wink page first.", { kind: "chat", label: "Vyre site planning" }, "juno", "Tue", 2),
      f("f13", "mine", "alex", "space", "Passport renewal is due 20 Oct.", { kind: "email", label: "Email from the passport office" }, "juno", "Mon", 1),
    ];
  },
  sealed(): SealedNote[] {
    return [{ subject: "Jane Doe", space: "juniper", labels: ["Date of birth", "SSN", "Account number"] }];
  },
  assistantName(id: string): string {
    return id === "kit" ? "kit" : id === "juno" ? "juno" : id;
  },
};
