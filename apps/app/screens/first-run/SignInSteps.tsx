// The two sign-in steps of the first-run flow, as plain views: a space, a username and a password (or Continue with GitHub), and, after GitHub, only the password. They hold no state and call no tool, so the gallery draws
// them from sample values and FirstRun.tsx drives them. v0.6.5, password only: nothing else is needed on any device.
import { Field, FlowStep, PasswordField, ProviderSignInButton, Text } from "@vyre/ui";
import { SIGNIN_COPY } from "../../../../lib/first-run-shape.js";

type Steps = { labels: string[]; current: number; kind?: "count" | "phase" };

export function SignInStep({ steps, onBack, backLabel, failure, space, onSpace, spaceBad, username, onUsername, password, onPassword, busy, canSubmit, onSubmit, onGithub }: {
  steps?: Steps; onBack?: () => void; backLabel?: string; failure?: string; space: string; onSpace: (v: string) => void; spaceBad: boolean; username: string; onUsername: (v: string) => void;
  password: string; onPassword: (v: string) => void; busy: boolean; canSubmit: boolean; onSubmit: () => void; onGithub: () => void;
}) {
  return (
    <FlowStep steps={steps} onBack={onBack} backLabel={backLabel} title={SIGNIN_COPY.title} lead={SIGNIN_COPY.lead} failure={failure}
      primary={{ label: busy ? "Unlocking..." : "Sign in", disabled: !canSubmit || busy, loading: busy, onPress: onSubmit }}>
      <Field label="Space address" name="Space address" value={space} onChangeText={onSpace} placeholder="tess or tess.vyre.run" error={spaceBad ? "Use the name of a space, like tess or tess.vyre.run." : undefined} />
      <Field label="Username" value={username} onChangeText={onUsername} />
      <PasswordField label="Password" value={password} onChangeText={onPassword} />
      <ProviderSignInButton disabled={busy} onPress={onGithub} />
    </FlowStep>
  );
}

export function SpacesStep({ steps, onBack, backLabel, failure, found, password, onPassword, busy, onSubmit }: {
  steps?: Steps; onBack?: () => void; backLabel?: string; failure?: string; found: { id?: string; name: string; role: string }[]; password: string; onPassword: (v: string) => void; busy: boolean; onSubmit: () => void;
}) {
  return (
    <FlowStep steps={steps} onBack={onBack} backLabel={backLabel} title={SIGNIN_COPY.spacesTitle} lead={SIGNIN_COPY.spacesLead} failure={failure}
      primary={{ label: busy ? "Unlocking..." : "Unlock", disabled: !password || busy, loading: busy, onPress: onSubmit }}>
      {found.map((x) => <Text key={x.id || x.name}>{`${x.name}, ${x.role}`}</Text>)}
      <PasswordField label="Password" value={password} onChangeText={onPassword} />
    </FlowStep>
  );
}
