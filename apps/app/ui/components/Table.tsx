import { RowsTable, type Column, type TableProps } from "./TableRows";

export type { Column, TableProps };

/**
 * The native Table (iOS and Android): the same data as Rows, the first column as the title and the others wrapped under it. No table library here;
 * the wide, sortable table with a header is Table.web.tsx (TanStack Table), and Metro picks the file by platform. Both take the same props.
 */
export function Table<T>(p: TableProps<T>) {
  return <RowsTable {...p} />;
}
