// Install flow sample data (public sample world). `loadInstall()` is the one read; a real source replaces it.
export type Look = { id: string; label: string };
export type Invite = { space: string; address: string; from: string; role: string; roleLine: string; sees: string; link: string };

export type Connector = { id: string; label: string; sub: string };
export type FirstKit = { id: string; label: string; sub: string };

/** Setup running on another of the person's devices (sample: the phone began creating Juniper Studio and the server is paired). `loadSetupElsewhere()` is the one read; a real source replaces it. */
export function loadSetupElsewhere(): { device: string; space: string; spaceName: string } | null {
  return { device: "iPhone", space: "juniper-studio", spaceName: "Juniper Studio" };
}

export function loadInstall() {
  const looks: Look[] = [
    { id: "violet", label: "Violet" }, { id: "amber", label: "Amber" }, { id: "sky", label: "Sky" }, { id: "sage", label: "Sage" }, { id: "rose", label: "Rose" },
  ];
  const invite: Invite = {
    space: "Juniper Studio", address: "juniper.vyre.run", from: "Chris Park", role: "Member", link: "juniper.vyre.run/join/7Kq2-M9",
    roleLine: "Works on the projects you are added to.",
    sees: "The projects you are added to and what Juniper Studio shares. Nothing else on your devices, and none of your other spaces.",
  };
  const connectors: Connector[] = [
    { id: "gmail", label: "Gmail", sub: "Mail the assistants can read and draft in" }, { id: "calendar", label: "Google Calendar", sub: "Meetings on Now" },
    { id: "drive", label: "Google Drive", sub: "Files in Drive" }, { id: "stripe", label: "Stripe", sub: "Payments, for the client-pays Flow" },
  ];
  const kits: FirstKit[] = [{ id: "estate", label: "Estate planning matter", sub: "2 record types, 3 Flows, 4 views and 1 role" }];
  return { looks, invite, connectors, kits, defaultSpaceName: "Juniper Studio", installCommand: "curl -fsSL vyre.run/i | sh" };
}
