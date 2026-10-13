// Copy the pdf.js worker next to the web export's static files: public/pdf/pdf.worker.min.mjs is what the file viewer's PDF page loads (ui/files/PdfDom.tsx), from the app's own address.
//   node scripts/pdf-worker.mjs        run by `npm run export:web` before `expo export`
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve("pdfjs-dist/package.json"));
const out = path.join(app, "public", "pdf");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(pkg, "build", "pdf.worker.min.mjs"), path.join(out, "pdf.worker.min.mjs"));
console.log("pdf worker: public/pdf/pdf.worker.min.mjs");
