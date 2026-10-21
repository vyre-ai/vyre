// Draws the open computer once, over the shell, on the web. The phone has no screen stream in the app window.
import { Platform } from "react-native";
import { useRouter } from "expo-router";
import { ComputerOverlay } from "./ComputerOverlay";
import { closeComputer, useComputerOpen } from "./computer-open";

export function ComputerHost() {
  const open = useComputerOpen((s) => s.open);
  const router = useRouter();
  if (!open || Platform.OS !== "web") return null;
  const route = open.route;
  return <ComputerOverlay agent={open.agent} onClose={() => { closeComputer(); if (route) router.back(); }} />;
}
