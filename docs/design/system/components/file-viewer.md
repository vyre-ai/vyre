---
title: File viewer
summary: One component that shows any file the way it should look, with the same chrome for all: name, version, who changed it, Show changes, Open in Files, Download, Edit. Its markdown mode is also the editor for an agent's or a project's instructions.
audience: builders
owner: app-design
status: draft
---

# File viewer

A file a person opens in Files, a file a model just made in a chat, and the instructions of an agent or a project are the same thing to read: a name, a version, some bytes. This component draws them
all, so a new file kind or a better editor is made once.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/files/FileViewer.tsx` (@vyre/ui) | built for markdown, code, text, JSON, images, PDF, DOCX, XLSX and CSV, HTML, audio and video (web) |
| Chat | a file card in the diff block opens it in a sheet (`screens/drive/FileViewerSheet.tsx`) | built |

## What it picks

By the file's name, then by the type the server gave (`ui/files/kinds.js`):

| Kind | Drawn as | Edit |
|---|---|---|
| Markdown | the app's typography: headings, lists, checklists, tables, code blocks, links, `@` and `#` tags as chips | yes: formatting bar, live preview, Enter continues a list |
| Code, text | line numbers and colours (the chat's tokenizer), scrolling by row | yes, plain |
| JSON | a tree that opens and closes | no |
| Image | zoom in steps, fit | no |
| PDF | react-pdf in a DOM-only component (`PdfDom.tsx`, "use dom"), zoom | no |
| DOCX | docx-preview (Apache-2.0) onto pages, `DocxDom.tsx` | no |
| XLSX, CSV, TSV | a read-only table on TanStack Table (MIT) with sheet tabs, column letters and row numbers, first 2,000 rows; XLSX by read-excel-file (MIT), CSV by Papa Parse (MIT), `SheetDom.tsx`. Old .xls shows the card. | no |
| HTML | a sandboxed frame with no scripts, no forms, no same-origin (web); a note on a phone | no |
| Audio, video | the browser's own player (web) | no |
| Anything else | a card with its size and Download | no |

## Props

`FileViewer({ name, source, kind?, startEditing?, readOnly?, onClose?, onOpenInFiles?, onDownload?, onTagInChat?, onSaved?, nameOf?, bare? })`.

`source` is where the file lives (`ui/files/source.ts`): `load(version?)` answers the bytes or the text, `versions()` the versions newest last, `save(text, base)` writes a new version. The Drive's is
`driveSource(path)` (`screens/drive/file-source.ts`); an agent's or a project's instructions pass their own (`projects.docs.set`, the agent's docs write). `kind` forces a kind (instructions are markdown
whatever the file is called). `bare` leaves out the header when the caller has its own.

## Behaviour

- Rendered by default. E or the Edit button opens the editor (text and markdown, on the latest version, when `source.save` exists). Cmd or Ctrl S saves; Esc leaves.
- Leaving with unsaved text (Close, another version, Cancel, Esc, unloading the page) asks first: Keep editing or Discard. A failed save keeps what was typed.
- A save is a new version. If someone else changed the file too, the server keeps both and the viewer says so.
- The version picker lists versions with who changed each (`Changed by <agent>`) and when. Show changes is a line diff against the version before (text and markdown), with the unchanged stretches folded.
- A file over the size the renderer reads, or a binary file opened as text, shows the card with Download instead.

## Gaps

- [ ] Audio and video on a phone, and old .xls spreadsheets (read-excel-file reads .xlsx only).
- [ ] The chat opens it in a sheet, not yet in the "In this chat" side panel.
- [ ] Text selection and links inside a PDF (the text and annotation layers are off).
- [ ] Files over 8 MB (the Drive's one-call limit; the ranged read exists on the mount branch).
- [ ] Clicking a checklist box in the rendered view to tick it (`toggleTask` is built and tested).
