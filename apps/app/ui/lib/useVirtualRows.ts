// The native stand-in for useVirtualRows.web.ts: every row is drawn (a native list scrolls its own rows), in the same shape the web one answers.
export function useVirtualRows(o: { count: number; getScrollElement: () => unknown; estimateSize: () => number; overscan?: number }) {
  const size = o.estimateSize();
  return {
    getTotalSize: () => o.count * size,
    getVirtualItems: () => Array.from({ length: o.count }, (_, index) => ({ index, start: index * size, size })),
  };
}
