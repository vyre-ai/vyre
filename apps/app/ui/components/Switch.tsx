import * as P from "@rn-primitives/switch";
import { cn } from "../lib/cn";

/** On or off. Never used for a destructive action. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange?: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <P.Root checked={on} onCheckedChange={onChange ?? (() => {})} disabled={disabled} accessibilityLabel={label}
      className={cn("h-s6 w-s10 flex-none justify-center rounded-full border", on ? "border-accent bg-accent" : "border-edge-strong bg-surface-3", disabled && "opacity-45")}>
      <P.Thumb className={cn("h-s4 w-s4 rounded-full", on ? "ml-s5 bg-accent-ink" : "ml-s1 bg-text-2")} />
    </P.Root>
  );
}
