// The web table: the sorting library (@tanstack/table-core) loads when the first table is drawn, not with the app (TableWeb.tsx is the table itself).
import { Suspense, lazy } from "react";
import type { Column, TableProps } from "./TableRows";

export type { Column, TableProps };
const Impl = lazy(() => import("./TableWeb").then((m) => ({ default: m.Table as (p: TableProps<any>) => React.ReactElement | null })));

export function Table<T>(p: TableProps<T>) {
  return <Suspense fallback={null}><Impl {...(p as TableProps<any>)} /></Suspense>;
}
