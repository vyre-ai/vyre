// The compose screen as a page: a New email title, the composer, and back to where the person came from once it is held.
import { useLocalSearchParams, useRouter } from "expo-router";
import { Page } from "../places/Frame";
import ComposeMail from "./ComposeMail";

export default function ComposeScreen() {
  const router = useRouter();
  const { to } = useLocalSearchParams<{ to?: string }>();
  return (
    <Page top title="New email">
      <ComposeMail {...(to ? { to: String(to) } : {})} onDone={() => (router.canGoBack() ? router.back() : router.replace("/u/mail" as never))} />
    </Page>
  );
}
