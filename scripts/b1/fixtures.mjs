import { degrees, PDFDocument, PDFName, PDFNumber, rgb, StandardFonts } from 'pdf-lib';

export async function fixtures(imageBase64) {
  const cases = [];
  for (const name of [
    'text',
    'rotated-cropped',
    'user-unit',
    'hidden-attachment',
    'shared-image',
    'zero-marks',
  ]) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 400]);
    page.drawText('B1_SECRET_CANARY', { x: 40, y: 300, size: 14, font });
    page.drawText('PUBLIC NEIGHBOR', { x: 40, y: 240, size: 14, font });
    page.drawRectangle({ x: 40, y: 100, width: 160, height: 40, color: rgb(0, 0.8, 0) });
    const marks = name === 'zero-marks' ? [] : [{ page: 0, rect: [35, 290, 220, 325] }];
    if (name === 'rotated-cropped') {
      page.setCropBox(20, 20, 340, 340);
      page.setRotation(degrees(90));
    }
    if (name === 'user-unit') page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    if (name === 'hidden-attachment') {
      page.drawText('HIDDEN_OCR_CANARY', { x: 40, y: 200, font, size: 12, opacity: 0 });
      await pdf.attach(Buffer.from('ATTACHMENT_CANARY'), 'private-name.txt');
      pdf.setSubject('METADATA_CANARY');
    }
    if (name === 'shared-image') {
      // A single image XObject reused across pages; marked pixels must not survive in the first output page.
      const image = await pdf.embedPng(Buffer.from(imageBase64, 'base64'));
      page.drawImage(image, { x: 40, y: 160, width: 100, height: 40 });
      pdf.addPage([400, 400]).drawImage(image, { x: 40, y: 160, width: 100, height: 40 });
      marks.push({ page: 0, rect: [35, 155, 145, 205] });
    }
    cases.push({ name, marks, bytes: Buffer.from(await pdf.save({ useObjectStreams: false })) });
  }
  return cases;
}
