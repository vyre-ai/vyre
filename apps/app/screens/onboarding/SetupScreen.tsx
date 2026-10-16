import { useEffect } from "react";
import { useRouter } from "expo-router";

/** The old ten-step setup is the three-phase first run. */
export function SetupScreen() {
  const router = useRouter();
  useEffect(() => { router.replace("/onboard" as never); }, [router]);
  return null;
}
