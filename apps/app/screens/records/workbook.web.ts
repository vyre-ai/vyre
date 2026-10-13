import readXlsxFile from "read-excel-file/universal";

export type Sheet = { name: string; grid: unknown[][] };

/** Every sheet of an .xlsx workbook as rows of cells (dates are Dates, numbers are numbers); parseGrid turns one into the rows an import reads. */
export async function readWorkbook(file: File): Promise<Sheet[]> {
  const sheets = await readXlsxFile(await file.arrayBuffer());
  return sheets.map((s) => ({ name: s.sheet, grid: s.data as unknown[][] }));
}
