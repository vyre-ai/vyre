// Drive's sample world, fed to the one Drive screen through mock-box.ts in a mock build (EXPO_PUBLIC_VYRE_MOCK=1). Nothing here is drawn by its own screen.

export type SampleFile = { path: string; ver: number; at: number; by: string; size: number; text?: string };
export type SampleArtifact = { id: string; title: string; kind: string; project: string };

const H = 3_600_000;
/** Fixed, so a render is the same twice. */
export const SAMPLE_NOW = Date.UTC(2026, 8, 30, 9, 5);

/** The space's files with their versions. A sealed file is not listed: the box keeps those away from the app. */
export const SAMPLE_FILES: SampleFile[] = [
  { path: "Doe estate plan/Trust agreement v4.pdf", ver: 4, at: SAMPLE_NOW, by: "kit", size: 184 * 1024 },
  { path: "Doe estate plan/Intake questionnaire.pdf", ver: 1, at: SAMPLE_NOW - 21 * 24 * H, by: "kit", size: 96 * 1024 },
  { path: "Doe estate plan/Engagement letter (signed).docx", ver: 3, at: SAMPLE_NOW - 24 * H, by: "chris", size: 58 * 1024 },
  { path: "Juniper Studio/Weekly report template.docx", ver: 7, at: SAMPLE_NOW - 5 * 24 * H, by: "juno", size: 41 * 1024 },
  { path: "Vyre site/Wink page copy.md", ver: 5, at: SAMPLE_NOW - 2 * 24 * H, by: "juno", size: 6 * 1024, text: "# Wink\n\nOne short code to join a space.\n" },
  { path: "Vyre site/Trail map.pdf", ver: 1, at: SAMPLE_NOW - 3 * 24 * H, by: "alex", size: 2_100_000 },
];

export const SAMPLE_ARTIFACTS: SampleArtifact[] = [
  { id: "a1", title: "Intake plan", kind: "Page", project: "Doe estate plan" },
  { id: "a2", title: "Weekly report", kind: "Page", project: "Juniper Studio" },
];
