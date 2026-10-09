import type { Picked } from "./import-source";

export const canPick = true;

/** Open the browser's file picker. The file's bytes are read once into base64 and handed back; nothing is stored. */
export function pickFile(accept: string): Promise<Picked | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let done = false;
    const finish = (v: Picked | null) => { if (done) return; done = true; input.remove(); resolve(v); };
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      const reader = new FileReader();
      reader.onload = () => { const s = String(reader.result ?? ""); finish({ name: file.name, base64: s.slice(s.indexOf(",") + 1) }); };
      reader.onerror = () => finish(null);
      reader.readAsDataURL(file);
    });
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
