// @ts-check
// RC1: what a browser says when the box asks for the person's own proof. The proof is made on the phone, so the browser never offers a button that would not work.

export const ON_PHONE = "Do this in Vyre on your phone.";

/** Is this refusal the box asking for the person's own proof (presence or approval)? @param {{ code?: string } | null | undefined} error */
export const needsPerson = (error) => Boolean(error) && ["presence_required", "needs_presence", "needs_approval"].includes(String(error?.code));
