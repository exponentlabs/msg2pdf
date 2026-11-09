import { GlobalWorkerOptions, getDocument, TextLayer, version } from './pdf.mjs';

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).href;
globalThis.b1Viewer = async ({ bytes, marks }) => {
  const task = getDocument({
    data: Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)),
    isEvalSupported: false,
    standardFontDataUrl: new URL('./standard_fonts/', import.meta.url).href,
    cMapUrl: new URL('./cmaps/', import.meta.url).href,
    cMapPacked: true,
    wasmUrl: new URL('./wasm/', import.meta.url).href,
  });
  const document = await task.promise;
  const result = [];
  try {
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      const scaled = page.getViewport({ scale: 2 });
      const canvas = globalThis.document.getElementById('page');
      canvas.width = Math.ceil(scaled.width);
      canvas.height = Math.ceil(scaled.height);
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: scaled }).promise;
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
          const rect = [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
          context.fillStyle = '#000000';
          context.fillRect(...rect);
          return rect.map((value) => value / 2);
        });
      result.push({
        width: viewport.width,
        height: viewport.height,
        regions,
        selection,
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
