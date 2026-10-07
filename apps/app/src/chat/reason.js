// @ts-check
// What the box refused, in words a person can read: never an id, never "thread" or "session".

/** @param {{ code?: string, message?: string }} e */
export const reason = (e) => {
  const m = String(e.message || "");
  if (e.code === "not_found" || /^no (thread|session|chat)\b/i.test(m)) return "This chat cannot be opened yet.";
  return (m.replace(/\b(?:chat|thread|spc|per)_[A-Za-z0-9-]+/g, "").replace(/\s+/g, " ").trim() || e.code) || "Refused";
};
