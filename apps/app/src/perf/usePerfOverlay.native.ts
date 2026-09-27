// Native feeds the meter from Reanimated's useFrameCallback on the UI thread; that lands in the spike.
export function usePerfOverlay(): boolean {
  return false;
}
