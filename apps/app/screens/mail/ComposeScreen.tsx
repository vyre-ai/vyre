// The compose screen as a page: a New email title, the composer, and back to where the person came from once it is held.
import { useRouter } from "expo-router";
import { Page } from "../places/Frame";
import ComposeMail from "./ComposeMail";

export default function ComposeScreen() {
  const router = useRouter();
  return (
    <Page top title="New email">
      <ComposeMail onDone={() => (router.canGoBack() ? router.back() : router.replace("/u/mail" as never))} />
    </Page>
  );
}
