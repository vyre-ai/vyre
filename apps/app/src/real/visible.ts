import { AppState, Platform } from "react-native";

/** Is the app on screen (so a poll should run)? The page's visibility on the web, the app state on a phone. */
export const appVisible = (): boolean => (Platform.OS === "web" ? typeof document === "undefined" || document.visibilityState !== "hidden" : AppState.currentState === "active");
