"use dom";
// A spreadsheet or a CSV as a read-only table: sheets as tabs, column letters, row numbers, the first rows only for a very long one. XLSX is read by read-excel-file (MIT), CSV and TSV by Papa Parse (MIT),
// the table by TanStack Table (MIT). DOM-only, so a "use dom" component. Nothing in a cell is ever run or turned into markup: it is text.
import { useEffect, useMemo, useState } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import Papa from "papaparse";
import readXlsxFile from "read-excel-file/universal";

type Grid = { name: string; rows: string[][] };
const MAX_ROWS = 2000;

const letters = (n: number) => { let s = ""; for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const show = (v: unknown): string => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

async function read(base64: string, kind: "csv" | "tsv" | "xlsx"): Promise<Grid[]> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (kind === "xlsx") {
    const sheets = await readXlsxFile(bytes.buffer as ArrayBuffer);
    return sheets.map((s) => ({ name: s.sheet, rows: s.data.map((r) => r.map(show)) }));
  }
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  const r = Papa.parse<string[]>(text, { delimiter: kind === "tsv" ? "\t" : "", skipEmptyLines: false });
  return [{ name: "Sheet 1", rows: r.data.map((row) => row.map(show)) }];
}

const SOFT = (n: number) => `color-mix(in srgb, currentColor ${n}%, transparent)`;
const MUTED = { opacity: 0.6 } as const;

function Table({ rows }: { rows: string[][] }) {
  const width = useMemo(() => rows.reduce((m, r) => Math.max(m, r.length), 0), [rows]);
  const columns = useMemo<ColumnDef<string[]>[]>(() => Array.from({ length: width }, (_, i) => ({ id: String(i), header: letters(i), accessorFn: (r) => r[i] ?? "" })), [width]);
  const data = useMemo(() => rows.slice(0, MAX_ROWS), [rows]);
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  const edge = SOFT(18), head = SOFT(10);
  const cell = { border: `1px solid ${edge}`, padding: "3px 8px", whiteSpace: "nowrap", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", fontSize: 13 } as const;
  return (
    <>
      <table style={{ borderCollapse: "collapse", fontFamily: "system-ui, sans-serif", color: "inherit" }}>
        <thead>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id}>
              <th style={{ ...cell, backgroundColor: "Canvas", backgroundImage: `linear-gradient(${head}, ${head})`, position: "sticky", top: 0, left: 0, zIndex: 2 }} />
              {g.headers.map((h) => <th key={h.id} style={{ ...cell, backgroundColor: "Canvas", backgroundImage: `linear-gradient(${head}, ${head})`, position: "sticky", top: 0, zIndex: 1, fontWeight: 500 }}>{flexRender(h.column.columnDef.header, h.getContext())}</th>)}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r, i) => (
            <tr key={r.id}>
              <td style={{ ...cell, backgroundColor: "Canvas", backgroundImage: `linear-gradient(${head}, ${head})`, textAlign: "right", position: "sticky", left: 0 }}>{i + 1}</td>
              {r.getVisibleCells().map((c) => <td key={c.id} style={cell} title={String(c.getValue())}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS ? <div style={{ padding: 10, fontFamily: "system-ui, sans-serif", fontSize: 13, ...MUTED }}>{`Showing the first ${MAX_ROWS} of ${rows.length} rows. Download the file for the rest.`}</div> : null}
    </>
  );
}

export default function SheetDom({ base64, kind, ink = "inherit" }: { base64: string; kind: "csv" | "tsv" | "xlsx"; ink?: string; dom?: import("expo/dom").DOMProps }) {
  const [grids, setGrids] = useState<Grid[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState(0);
  useEffect(() => {
    let live = true;
    setGrids(null); setFailed(false); setTab(0);
    read(base64, kind).then((g) => { if (live) setGrids(g); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [base64, kind]);
  const note = { padding: 16, fontFamily: "system-ui, sans-serif", fontSize: 14, ...MUTED } as const;
  if (failed) return <div style={note}>This file could not be read as a table. Download it to open it.</div>;
  if (!grids) return <div style={note}>Opening</div>;
  const g = grids[Math.min(tab, grids.length - 1)];
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: ink, colorScheme: "normal" }}>
      <div style={{ flex: 1, overflow: "auto" }}>{g ? <Table rows={g.rows} /> : null}</div>
      {grids.length > 1 ? (
        <div style={{ display: "flex", gap: 4, padding: 6, borderTop: `1px solid ${SOFT(25)}`, overflowX: "auto" }}>
          {grids.map((s, i) => <button key={i} onClick={() => setTab(i)} style={{ font: "13px system-ui, sans-serif", padding: "4px 10px", borderRadius: 8, border: `1px solid ${SOFT(30)}`, background: i === tab ? SOFT(20) : "transparent", color: "inherit", cursor: "pointer" }}>{s.name}</button>)}
        </div>
      ) : null}
    </div>
  );
}
