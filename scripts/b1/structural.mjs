import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The separately installed AGPL evaluation module is never copied into a package.
const mupdf = await import(pathToFileURL(process.env.B1_MUPDF_MODULE).href);
const [input, output, marksFile] = process.argv.slice(2);
const document = mupdf.Document.openDocument(readFileSync(input), 'application/pdf');
const marks = JSON.parse(readFileSync(marksFile, 'utf8'));
for (let index = 0; index < document.countPages(); index++) {
  const page = document.loadPage(index);
  for (const mark of marks.filter((item) => item.page === index)) {
    // MuPDF uses top-left page coordinates; inverse PDF transform handles crop/rotation.
    const rect = mupdf.Rect.transform(mark.rect, page.getTransform());
    const annotation = page.createAnnotation('Redact');
    annotation.setRect(rect);
    annotation.update();
  }
  page.applyRedactions(true, 2, 2, 0);
}
// Capability experiment deliberately does not claim a complete structural sanitizer.
writeFileSync(output, document.saveToBuffer('garbage=4,clean,compress').asUint8Array());
document.destroy();
