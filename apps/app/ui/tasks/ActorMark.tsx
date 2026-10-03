import { Avatar, type AvatarFamily } from "../components/Avatar";

type Who = { name: string; family?: string };

/** An actor's mark, by what it is: a person is a circle, an assistant, teammate or service a rounded square with the accent hairline. */
export function ActorMark({ who, size = "md" }: { who?: Who; size?: "sm" | "md" | "lg" }) {
  const f = who?.family;
  const family: AvatarFamily = f === "person" ? "person" : f === "teammate" ? "teammate" : "assistant";
  return <Avatar name={who?.name || "Vyre"} family={family} size={size} />;
}
