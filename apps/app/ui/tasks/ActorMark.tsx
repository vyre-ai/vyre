import { Avatar, kindOf, type AvatarSize } from "../components/Avatar";
import type { AvatarRef } from "../components/Avatar";

type Who = { id?: string; name: string; family?: string; seed?: string };
const PX = { sm: 24, md: 32, lg: 40 } as const;

/** An actor's mark, by what it is: a person's Wink face, an assistant's creature, a teammate's character, a service the agent mark. `space` adds the corner badge. */
export function ActorMark({ who, size = "md", space, onPress }: { who?: Who; size?: "sm" | "md" | "lg" | AvatarSize; space?: AvatarRef; onPress?: () => void }) {
  const name = who?.name || "Vyre";
  const px = typeof size === "number" ? size : PX[size];
  return <Avatar of={{ kind: kindOf(who?.family), id: who?.id || name, name, seed: who?.seed }} size={px as AvatarSize} space={space} onPress={onPress} />;
}
