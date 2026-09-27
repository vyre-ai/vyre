import { signIn } from "../api/box";
import { useSignInNeeded } from "../state/connection";
import { Banner } from "./Banner";
import { Button } from "./Button";

/**
 * The box answered 401 person_session_required: writes wait in the outbox (none is lost or run
 * twice) until the person signs in. One fact, one action, which starts the box's sign-in.
 */
export function SignInBar() {
  const needed = useSignInNeeded();
  if (!needed) return null;
  return <Banner live fact="Sign in to your box to send what waits" action={<Button kind="outline" label="Sign in" onPress={() => void signIn()} />} />;
}
