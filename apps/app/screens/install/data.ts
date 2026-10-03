// Install flow sample data (public sample world). `loadInstall()` is the one read; a real source replaces it.
export type Look = { id: string; label: string };
export type Invite = { space: string; address: string; from: string; role: string; roleLine: string; sees: string; link: string };

export function loadInstall() {
  const looks: Look[] = [
    { id: "violet", label: "Violet" }, { id: "amber", label: "Amber" }, { id: "sky", label: "Sky" }, { id: "sage", label: "Sage" }, { id: "rose", label: "Rose" },
  ];
  const invite: Invite = {
    space: "Harlow Legal", address: "harlow.vyre.run", from: "Chris Park", role: "Member", link: "harlow.vyre.run/join/7Kq2-M9",
    roleLine: "Works on the projects you are added to.",
    sees: "The projects you are added to and what Harlow Legal shares. Nothing else on your devices, and none of your other spaces.",
  };
  return { looks, invite, defaultSpaceName: "Northwind Bakery", installCommand: "curl -fsSL vyre.run/i | sh" };
}
