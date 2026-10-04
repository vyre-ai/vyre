// @ts-check
// RC1: what a browser says when the box asks for the person's own proof. The proof is made on the phone, so the browser never offers a button that would not work.

export const ON_PHONE = "Do this in Vyre on your phone.";

/** Is this refusal the box asking for the person's own proof (presence or approval)? @param {{ code?: string } | null | undefined} error */
export const needsPerson = (error) => Boolean(error) && ["presence_required", "needs_presence", "needs_approval"].includes(String(error?.code));

/** The refusal in a browser, naming what the person is asked to do on the phone. @param {string} tool */
export function onPhoneFor(tool) {
  const t = String(tool);
  if (/reveal/.test(t)) return "Reveal it in Vyre on your phone.";
  if (/^tasks\.decide/.test(t)) return "Approve it in Vyre on your phone.";
  if (/^(grants|spaces\.roles|spaces\.members)\./.test(t)) return "Change who can use this in Vyre on your phone.";
  if (/^wink\./.test(t)) return "Pair it in Vyre on your phone.";
  if (/drive\.restore/.test(t)) return "Restore it in Vyre on your phone.";
  return ON_PHONE;
}
