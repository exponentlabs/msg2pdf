import { GlobalWorkerOptions, getDocument, TextLayer, version } from './pdf.mjs';

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).href;
globalThis.b1Viewer = async ({ bytes, marks }) => {
  const task = getDocument({
    data: Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)),
    isEvalSupported: false,
    stopAtErrors: true,
    standardFontDataUrl: new URL('./standard_fonts/', import.meta.url).href,
    cMapUrl: new URL('./cmaps/', import.meta.url).href,
    cMapPacked: true,
    wasmUrl: new URL('./wasm/', import.meta.url).href,
  });
  const result = [];
  try {
    const document = await task.promise;
    if (document.numPages > 8) throw new Error('PAGE_LIMIT');
    let totalPixels = 0;
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      const scaled = page.getViewport({ scale: 2 });
      totalPixels += Math.ceil(scaled.width) * Math.ceil(scaled.height);
      if (viewport.width > 2000 || viewport.height > 2000 || totalPixels > 4_000_000)
        throw new Error('PIXEL_LIMIT');
      const canvas = globalThis.document.getElementById('page');
      canvas.width = Math.ceil(scaled.width);
      canvas.height = Math.ceil(scaled.height);
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: scaled }).promise;
      const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const rgb = new Uint8Array(canvas.width * canvas.height * 3);
      for (let pixel = 0; pixel < canvas.width * canvas.height; pixel++) {
        rgb[pixel * 3] = sourcePixels[pixel * 4];
        rgb[pixel * 3 + 1] = sourcePixels[pixel * 4 + 1];
        rgb[pixel * 3 + 2] = sourcePixels[pixel * 4 + 2];
      }
      let encodedRgb = '';
      for (let at = 0; at < rgb.length; at += 32768)
        encodedRgb += String.fromCharCode(...rgb.subarray(at, at + 32768));
      const referenceRgb = btoa(encodedRgb);
      const text = await page.getTextContent();
      const container = globalThis.document.getElementById('text');
      container.replaceChildren();
      container.style.setProperty('--scale-factor', '2');
      container.style.setProperty('--user-unit', String(page.userUnit));
      container.style.setProperty('--total-scale-factor', String(scaled.scale));
      const layer = new TextLayer({ textContentSource: text, container, viewport: scaled });
      await layer.render();
      const selected = layer.textDivs.find((item) => item.textContent.includes('PUBLIC NEIGHBOR'));
      let selection = null;
      if (selected) {
        const range = globalThis.document.createRange();
        range.selectNodeContents(selected);
        const current = globalThis.getSelection();
        current.removeAllRanges();
        current.addRange(range);
        const bounds = range.getBoundingClientRect();
        selection = { text: current.toString(), width: bounds.width, height: bounds.height };
        current.removeAllRanges();
      }
      const regions = marks
        .filter((mark) => mark.page === index - 1)
        .map((mark) => {
          const [x1, y1] = scaled.convertToViewportPoint(mark.rect[0], mark.rect[1]);
          const [x2, y2] = scaled.convertToViewportPoint(mark.rect[2], mark.rect[3]);
          const left = Math.floor(Math.min(x1, x2));
          const top = Math.floor(Math.min(y1, y2));
          const rect = [
            left,
            top,
            Math.ceil(Math.max(x1, x2)) - left,
            Math.ceil(Math.max(y1, y2)) - top,
          ];
          context.fillStyle = '#000000';
          context.fillRect(...rect);
          return rect.map((value) => value / 2);
        });
      result.push({
        width: viewport.width,
        height: viewport.height,
        regions,
        selection,
        referenceRgb,
        png: canvas.toDataURL('image/png').split(',')[1],
        text: text.items
          .filter((item) => 'str' in item)
          .map((item) => item.str)
          .join(' '),
        // Round-trip one canonical corner at a different zoom; B4 must test interactive selection.
        geometry: marks
          .filter((mark) => mark.page === index - 1)
          .every((mark) => {
            const point = viewport.convertToViewportPoint(mark.rect[0], mark.rect[1]);
            const back = viewport.convertToPdfPoint(...point);
            return (
              Math.abs(back[0] - mark.rect[0]) < 0.001 && Math.abs(back[1] - mark.rect[1]) < 0.001
            );
          }),
      });
      page.cleanup();
    }
    return { version, pages: result };
  } finally {
    await task.destroy();
  }
};
