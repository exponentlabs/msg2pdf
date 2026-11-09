import {
  clip,
  degrees,
  endPath,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  StandardFonts,
} from 'pdf-lib';

export async function fixtures(imageBase64) {
  const cases = [];
  for (const name of [
    'text',
    'rotated-cropped',
    'user-unit',
    'hidden-attachment',
    'shared-image',
    'zero-marks',
    'forms-actions-tags',
    'fragmented-clipped-vector',
    'old-revision',
    'mixed-rotations-layers',
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
    if (name === 'forms-actions-tags') {
      const field = pdf.getForm().createTextField('PRIVATE_FIELD_CANARY');
      field.setText('FORM VALUE');
      field.addToPage(page, { x: 240, y: 100, width: 140, height: 25 });
      pdf.getForm().updateFieldAppearances(font);
      pdf.catalog.set(
        PDFName.of('OpenAction'),
        pdf.context.obj({ S: 'JavaScript', JS: PDFHexString.fromText('ACTION_CANARY') }),
      );
      pdf.catalog.set(
        PDFName.of('StructTreeRoot'),
        pdf.context.obj({
          Type: 'StructTreeRoot',
          K: [],
          Alt: PDFHexString.fromText('ALT_TEXT_CANARY'),
        }),
      );
      const metadata = pdf.context.register(
        pdf.context.stream('<x:xmpmeta>XML_CANARY</x:xmpmeta>', {
          Type: 'Metadata',
          Subtype: 'XML',
        }),
      );
      pdf.catalog.set(PDFName.of('Metadata'), metadata);
    }
    if (name === 'fragmented-clipped-vector') {
      page.drawText('FRAGMENT_', { x: 40, y: 270, size: 14, font });
      page.drawText('CANARY', { x: 130, y: 270, size: 14, font });
      marks.push({ page: 0, rect: [35, 260, 220, 285] });
      const unicode =
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /LigatureMap def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <41> <00660069> <42> <0066006c> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
      const toUnicode = pdf.context.register(pdf.context.stream(unicode));
      const ligatureFont = pdf.context.register(
        pdf.context.obj({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          Encoding: {
            Type: 'Encoding',
            BaseEncoding: 'WinAnsiEncoding',
            Differences: [65, PDFName.of('fi'), PDFName.of('fl')],
          },
          ToUnicode: toUnicode,
        }),
      );
      page.node.Resources().lookup(PDFName.of('Font')).set(PDFName.of('LigatureMap'), ligatureFont);
      page.node.addContentStream(
        pdf.context.register(pdf.context.stream('BT /LigatureMap 14 Tf 40 270 Td (AB) Tj ET')),
      );
      page.pushOperators(pushGraphicsState(), rectangle(250, 200, 50, 50), clip(), endPath());
      page.drawText('CLIPPED_CANARY', { x: 300, y: 200, size: 14, font });
      page.pushOperators(popGraphicsState());
      page.drawRectangle({ x: 40, y: 160, width: 100, height: 40, color: rgb(1, 0, 0) });
      marks.push({ page: 0, rect: [35, 155, 145, 205] });
    }
    if (name === 'old-revision') pdf.setSubject('OLD_REVISION_CANARY');
    if (name === 'mixed-rotations-layers') {
      for (const [width, height, rotation] of [
        [300, 500, 180],
        [500, 300, 270],
      ]) {
        const extra = pdf.addPage([width, height]);
        extra.setRotation(degrees(rotation));
        extra.drawText('B1_SECRET_CANARY', { x: 40, y: height - 100, font, size: 14 });
        extra.drawText('PUBLIC NEIGHBOR', { x: 40, y: height - 160, font, size: 14 });
        marks.push({ page: pdf.getPageCount() - 1, rect: [35, height - 110, 220, height - 75] });
      }
      const layer = pdf.context.register(
        pdf.context.obj({ Type: 'OCG', Name: PDFHexString.fromText('PRIVATE_LAYER_CANARY') }),
      );
      pdf.catalog.set(
        PDFName.of('OCProperties'),
        pdf.context.obj({ OCGs: [layer], D: { OFF: [layer], Order: [layer] } }),
      );
      page.node.Resources().set(PDFName.of('Properties'), pdf.context.obj({ SecretLayer: layer }));
      page.node.Resources().lookup(PDFName.of('Font')).set(PDFName.of('Helvetica'), font.ref);
      page.node.addContentStream(
        pdf.context.register(
          pdf.context.stream(
            '/OC /SecretLayer BDC BT /Helvetica 12 Tf 40 160 Td (HIDDEN_LAYER_CANARY) Tj ET EMC',
          ),
        ),
      );
    }
    let bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
    if (name === 'old-revision') {
      const previous = Number(bytes.toString('latin1').match(/startxref\s+(\d+)\s+%%EOF$/)[1]);
      const info = pdf.context.trailerInfo.Info;
      const root = pdf.context.trailerInfo.Root;
      const offset = bytes.length + 1;
      const object = `${info.objectNumber} 0 obj\n<< /Subject (PUBLIC) >>\nendobj\n`;
      const tail = `xref\n${info.objectNumber} 1\n${String(offset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${pdf.context.largestObjectNumber + 1} /Root ${root} /Info ${info} /Prev ${previous} >>\nstartxref\n${offset + Buffer.byteLength(object)}\n%%EOF`;
      bytes = Buffer.concat([bytes, Buffer.from(`\n${object}${tail}`)]);
    }
    cases.push({
      name,
      marks,
      bytes,
      structural: [
        'text',
        'rotated-cropped',
        'user-unit',
        'hidden-attachment',
        'shared-image',
        'zero-marks',
      ].includes(name),
    });
  }
  return cases;
}
