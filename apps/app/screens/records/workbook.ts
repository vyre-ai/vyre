/** Reading a spreadsheet is web only (the file pick is); a phone never gets here. */
export type Sheet = { name: string; grid: unknown[][] };
export async function readWorkbook(_file: File): Promise<Sheet[]> {
  throw new Error("Spreadsheets can be imported on the web.");
}
