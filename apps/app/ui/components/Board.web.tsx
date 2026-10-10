// The web board: the drag-and-drop library (@dnd-kit) loads when the first board is drawn, not with the app (BoardWeb.tsx is the board itself).
import { Suspense, lazy } from "react";
import type { BoardProps } from "./BoardStacked";

const Impl = lazy(() => import("./BoardWeb").then((m) => ({ default: m.Board as (p: BoardProps<any>) => React.ReactElement | null })));

export function Board<T>(props: BoardProps<T>) {
  return <Suspense fallback={null}><Impl {...(props as BoardProps<any>)} /></Suspense>;
}
