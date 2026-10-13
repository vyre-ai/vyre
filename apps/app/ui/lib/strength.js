// How strong a master password is, in words a person can act on. Four levels. The rule is length first, then variety, then the obvious.
// It never rejects a password by itself: the screen asks for "Good" or better before it lets the person go on.

const COMMON = ["password", "12345678", "qwertyui", "letmein", "iloveyou", "vyre"];

/** @param {string} pw @returns {{ score: 0 | 1 | 2 | 3 | 4, label: string, hint: string }} */
export function passwordStrength(pw) {
  const s = String(pw ?? "");
  if (!s) return { score: 0, label: "", hint: "" };
  const lower = s.toLowerCase();
  if (COMMON.some((c) => lower.includes(c)) && s.length < 16) return { score: 1, label: "Weak", hint: "That is a common one. Use four unrelated words, or a longer phrase." };
  if (s.length < 8) return { score: 1, label: "Weak", hint: "Use at least 8 characters. A phrase of four words is easy to remember and hard to guess." };
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  const words = s.split(/[\s-]+/).filter(Boolean).length;
  if (s.length >= 16 || (words >= 4 && s.length >= 14)) return { score: 4, label: "Strong", hint: "Good. Vyre cannot reset it, so keep it in your recovery kit." };
  if (s.length >= 12 && kinds >= 2) return { score: 3, label: "Good", hint: "Good. A longer phrase would make it stronger." };
  if (kinds >= 3 && s.length >= 10) return { score: 3, label: "Good", hint: "Good. A longer phrase would make it stronger." };
  return { score: 2, label: "Fair", hint: "Add a few more words or characters." };
}
