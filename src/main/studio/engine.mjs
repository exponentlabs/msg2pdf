import { GlobalWorkerOptions, getDocument } from './pdf.mjs';

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).href;
globalThis.prepareStudioSnapshot = async ({ bytes, pageInfos }) => {
  if (typeof bytes !== 'string' || bytes.length > 140 * 1024 * 1024) throw new Error('INPUT_LIMIT');
  const task = getDocument({
    data: Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)),
    isEvalSupported: false,
    stopAtErrors: true,
    verbosity: 0,
    standardFontDataUrl: new URL('./standard_fonts/', import.meta.url).href,
    cMapUrl: new URL('./cmaps/', import.meta.url).href,
    cMapPacked: true,
    wasmUrl: new URL('./wasm/', import.meta.url).href,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages < 1 || pdf.numPages > 8 || pdf.numPages !== pageInfos.length)
      throw new Error('PAGE_LIMIT');
    const pages = [];
    let totalPixels = 0;
    for (let index = 0; index < pdf.numPages; index++) {
      const page = await pdf.getPage(index + 1);
      const info = pageInfos[index];
      if (
        page.rotate !== info.rotation ||
        page.userUnit !== info.userUnit ||
        page.view.some((value, at) => Math.abs(value - info.cropBox[at]) > 0.001)
      )
        throw new Error('GEOMETRY_DISAGREEMENT');
      const viewport = page.getViewport({ scale: 1 });
      const raster = page.getViewport({ scale: 2 });
      const width = Math.ceil(raster.width);
      const height = Math.ceil(raster.height);
      totalPixels += width * height;
      if (
        !Number.isFinite(viewport.width) ||
        !Number.isFinite(viewport.height) ||
        viewport.width <= 0 ||
        viewport.height <= 0 ||
        viewport.width > 2000 ||
        viewport.height > 2000 ||
        totalPixels > 4_000_000
      )
        throw new Error('PIXEL_LIMIT');
      const canvas = document.getElementById('page');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: raster }).promise;
      const rgba = context.getImageData(0, 0, width, height).data;
      const rgb = new Uint8Array(width * height * 3);
      for (let pixel = 0; pixel < width * height; pixel++)
        for (let channel = 0; channel < 3; channel++)
          rgb[pixel * 3 + channel] = rgba[pixel * 4 + channel];
      let binary = '';
      for (let at = 0; at < rgb.length; at += 32768)
        binary += String.fromCharCode(...rgb.subarray(at, at + 32768));
      const content = await page.getTextContent();
      if (content.items.length > 50_000) throw new Error('TEXT_LIMIT');
      const text = [];
      for (const item of content.items) {
        if (
          !('str' in item) ||
          !item.str ||
          item.str.length > 10_000 ||
          content.styles[item.fontName]?.vertical
        )
          continue;
        const [a, b, , , x, y] = item.transform;
        const length = Math.hypot(a, b);
        if (!length) continue;
        const ux = a / length;
        const uy = b / length;
        const h = item.height;
        const points = [
          [x + uy * h * 0.25, y - ux * h * 0.25],
          [x + ux * item.width + uy * h * 0.25, y + uy * item.width - ux * h * 0.25],
          [x - uy * h, y + ux * h],
          [x + ux * item.width - uy * h, y + uy * item.width + ux * h],
        ];
        const rect = [
          Math.max(info.cropBox[0], Math.min(...points.map(([px]) => px))),
          Math.max(info.cropBox[1], Math.min(...points.map(([, py]) => py))),
          Math.min(info.cropBox[2], Math.max(...points.map(([px]) => px))),
          Math.min(info.cropBox[3], Math.max(...points.map(([, py]) => py))),
        ];
        if (rect[2] > rect[0] && rect[3] > rect[1]) text.push({ text: item.str, rect });
      }
      pages.push({
        width: viewport.width,
        height: viewport.height,
        transform: viewport.transform,
        info,
        png: canvas.toDataURL('image/png').split(',')[1],
        referenceRgb: btoa(binary),
        text,
      });
      page.cleanup();
    }
    return { pages };
  } finally {
    await task.destroy();
  }
};
