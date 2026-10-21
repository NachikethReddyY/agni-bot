/** Isolated PDF extraction: the caller kills this process on timeout. */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

try {
  const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  const task = getDocument({ data: bytes, useSystemFonts: false });
  const doc = await task.promise;
  try {
    if (doc.numPages > 100) throw new Error("PDFs are limited to 100 pages.");
    let text = "";
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      text += content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("") + "\n";
      if (text.length > 60_000) throw new Error("PDF text exceeds 60,000 characters. Attach a shorter excerpt.");
    }
    if (!text.trim()) throw new Error("This PDF has no selectable text. OCR is not supported yet.");
    console.log(JSON.stringify({ text }));
  } finally {
    await task.destroy();
  }
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : "Cannot read this PDF." }));
  process.exitCode = 1;
}
