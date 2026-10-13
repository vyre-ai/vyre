// A long list that draws only the rows in view (web). The one place the virtual-list library is imported; screens take this from "@vyre/ui".
import { useVirtualizer } from "@tanstack/react-virtual";

export function useVirtualRows(o: { count: number; getScrollElement: () => HTMLElement | null; estimateSize: () => number; overscan?: number }) {
  return useVirtualizer(o);
}
