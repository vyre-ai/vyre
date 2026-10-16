import { Button } from "./Button";

/** Continue with a provider. GitHub signs the person in. The master password still unlocks the vault. */
export function ProviderSignInButton({ label = "Continue with GitHub", onPress, disabled, loading }: { label?: string; onPress: () => void; disabled?: boolean; loading?: boolean }) {
  return <Button kind="secondary" size="lg" className="w-full" icon="globe" label={label} onPress={onPress} disabled={disabled} loading={loading} />;
}
