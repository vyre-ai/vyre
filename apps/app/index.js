// The app's entry. The headless notice task has to be registered before anything else is needed, because the Android service that keeps the connection while the app is closed starts it with no screen
// (src/native/headless.android.ts); then the router as before.
import "./src/native/headless";
import "expo-router/entry";
