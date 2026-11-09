const assert = require('node:assert/strict');
const { inflateSync } = require('node:zlib');
const { createHash } = require('node:crypto');

// An independent, deliberately narrow verifier for the fresh-raster serialization.
// It does not import the assembler or interpret arbitrary source PDF content streams.
exports.verifyRaster = (bytes, decoded, encoded, expected) => {
  assert.equal(decoded.version, 2);
  assert.equal(encoded.version, 2);
  assert.equal(decoded.encrypt.encrypted, false);
  assert.equal(decoded.pages.length, expected.pages.length);
  assert(expected.pages.length > 0 && expected.pages.length <= 8);
  const objects = decoded.qpdf[1];
  const raw = encoded.qpdf[1];
  const roles = new Map();
  const used = new Set();
  const reference = (ref, role) => {
    assert.match(ref, /^[1-9]\d* 0 R$/);
    assert(!used.has(ref), `Duplicate object role: ${role}`);
    used.add(ref);
    roles.set(ref, role);
    const value = objects[`obj:${ref}`];
    assert(value, 'Missing referenced object');
    return value;
  };
  const keys = (value, allowed) => assert.deepEqual(Object.keys(value).sort(), [...allowed].sort());
  const trailer = objects.trailer.value;
  keys(trailer, ['/Size', '/Root', '/Info']);
  const catalog = reference(trailer['/Root'], 'catalog').value;
  keys(catalog, ['/Type', '/Pages']);
  assert.equal(catalog['/Type'], '/Catalog');
  const tree = reference(catalog['/Pages'], 'tree').value;
  keys(tree, ['/Type', '/Kids', '/Count']);
  assert.equal(tree['/Type'], '/Pages');
  assert.equal(tree['/Count'], expected.pages.length);
  assert.equal(tree['/Kids'].length, expected.pages.length);
  const info = reference(trailer['/Info'], 'info').value;
  keys(info, ['/Creator', '/Producer']);
  assert.equal(info['/Creator'], 'u:msg2pdf');
  assert.equal(info['/Producer'], 'u:msg2pdf raster-v1');
  for (let index = 0; index < expected.pages.length; index++) {
    const target = expected.pages[index];
    const pageRef = tree['/Kids'][index];
    assert.equal(decoded.pages[index].object, pageRef);
    const page = reference(pageRef, 'page').value;
    keys(page, ['/Type', '/Parent', '/Resources', '/MediaBox', '/Annots', '/Contents']);
    assert.equal(page['/Type'], '/Page');
    assert.equal(page['/Parent'], catalog['/Pages']);
    assert.deepEqual(page['/Annots'], []);
    assert.deepEqual(page['/MediaBox'], [0, 0, target.width, target.height]);
    assert(target.width > 0 && target.height > 0 && target.width <= 2000 && target.height <= 2000);
    const resources = page['/Resources'];
    keys(resources, ['/Font', '/XObject', '/ExtGState']);
    assert.deepEqual(resources['/Font'], {});
    assert.deepEqual(resources['/ExtGState'], {});
    const images = Object.entries(resources['/XObject']);
    assert.equal(images.length, 1);
    const [imageName, imageRef] = images[0];
    assert.match(imageName, /^\/Image-\d+$/);
    const image = reference(imageRef, 'image').stream;
    keys(image.dict, [
      '/Type',
      '/Subtype',
      '/Width',
      '/Height',
      '/ColorSpace',
      '/BitsPerComponent',
    ]);
    assert.equal(image.dict['/Type'], '/XObject');
    assert.equal(image.dict['/Subtype'], '/Image');
    assert.equal(image.dict['/ColorSpace'], '/DeviceRGB');
    assert.equal(image.dict['/BitsPerComponent'], 8);
    const width = Math.ceil(target.width * 2);
    const height = Math.ceil(target.height * 2);
    assert.equal(image.dict['/Width'], width);
    assert.equal(image.dict['/Height'], height);
    const pixels = Buffer.from(image.data, 'base64');
    assert.equal(pixels.length, width * height * 3);
    const referencePixels = Buffer.from(target.referenceRgb, 'base64');
    assert.equal(referencePixels.length, pixels.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const masked = target.regions.some(
          ([rx, ry, rw, rh]) =>
            x >= rx * 2 && x < (rx + rw) * 2 && y >= ry * 2 && y < (ry + rh) * 2,
        );
        if (!masked) {
          const at = (y * width + x) * 3;
          assert.equal(pixels[at], referencePixels[at], 'Unmarked pixel changed');
          assert.equal(pixels[at + 1], referencePixels[at + 1], 'Unmarked pixel changed');
          assert.equal(pixels[at + 2], referencePixels[at + 2], 'Unmarked pixel changed');
        }
      }
    for (const [x, y, w, h] of target.regions) {
      assert([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0);
      assert([x, y, w, h].every((value) => Number.isInteger(value * 2)));
      assert(x >= 0 && y >= 0 && x + w <= width / 2 && y + h <= height / 2);
      for (let py = Math.ceil(y * 2); py < Math.floor((y + h) * 2); py++) {
        for (let px = Math.ceil(x * 2); px < Math.floor((x + w) * 2); px++) {
          const at = (py * width + px) * 3;
          assert.equal(pixels[at], 0);
          assert.equal(pixels[at + 1], 0);
          assert.equal(pixels[at + 2], 0);
        }
      }
    }
    assert.equal(page['/Contents'].length, 1);
    const content = reference(page['/Contents'][0], 'content').stream;
    keys(content.dict, []);
    const tokens = Buffer.from(content.data, 'base64')
      .toString('ascii')
      .trim()
      .split(/\s+/)
      .join(' ');
    assert.equal(
      tokens,
      `q 1 0 0 1 0 0 cm 1 0 0 1 0 0 cm ${target.width} 0 0 ${target.height} 0 0 cm 1 0 0 1 0 0 cm ${imageName} Do Q`,
    );
  }
  assert.equal(Object.keys(objects).length, used.size + 1, 'Unreferenced or forbidden object');
  assert.equal(trailer['/Size'], used.size + 1);
  // Check compressed stream consumption, so data after the zlib end cannot hide in an image stream.
  for (const ref of used) {
    const value = objects[`obj:${ref}`];
    const source = raw[`obj:${ref}`];
    if (value.stream) {
      keys(source.stream.dict, [...Object.keys(value.stream.dict), '/Filter']);
      assert.equal(source.stream.dict['/Filter'], '/FlateDecode');
      const compressed = Buffer.from(source.stream.data, 'base64');
      const result = inflateSync(compressed, { info: true, maxOutputLength: 48 * 1024 * 1024 });
      assert.equal(result.engine.bytesWritten, compressed.length);
      assert(result.buffer.equals(Buffer.from(value.stream.data, 'base64')));
    }
  }
  // Reconstruct the entire permitted serialization from QPDF's independent parse.
  // Exact equality rejects comments, stale revisions, hidden gaps, extra trailers and trailing payloads.
  const orders = {
    catalog: ['/Type', '/Pages'],
    tree: ['/Type', '/Kids', '/Count'],
    info: ['/Producer', '/Creator'],
    page: ['/Type', '/Parent', '/Resources', '/MediaBox', '/Annots', '/Contents'],
    image: [
      '/Type',
      '/Subtype',
      '/BitsPerComponent',
      '/Width',
      '/Height',
      '/ColorSpace',
      '/Filter',
      '/Length',
    ],
    content: ['/Filter', '/Length'],
    resources: ['/Font', '/XObject', '/ExtGState'],
    trailer: ['/Size', '/Root', '/Info'],
  };
  function serialize(value, role) {
    if (Array.isArray(value))
      return `[ ${value.map((item) => serialize(item)).join(' ')}${value.length ? ' ' : ''}]`;
    if (typeof value === 'number') {
      assert(Number.isFinite(value));
      return String(value);
    }
    if (typeof value === 'string') {
      if (value.startsWith('u:'))
        return `<FEFF${Array.from(value.slice(2))
          .map((c) => c.charCodeAt(0).toString(16).padStart(4, '0'))
          .join('')
          .toUpperCase()}>`;
      assert(/^\/[\w-]+$|^\d+ 0 R$/.test(value));
      return value;
    }
    assert(value && typeof value === 'object');
    const order = orders[role] ?? Object.keys(value);
    return `<<\n${order
      .filter((key) => key in value)
      .map(
        (key) =>
          `${key} ${serialize(value[key], key === '/Resources' ? 'resources' : undefined)}\n`,
      )
      .join('')}>>`;
  }
  const pieces = [Buffer.from('%PDF-1.7\n%\x81\x81\x81\x81\n\n', 'latin1')];
  const offsets = [0];
  let offset = pieces[0].length;
  for (let id = 1; id < trailer['/Size']; id++) {
    const ref = `${id} 0 R`;
    assert(used.has(ref));
    const value = raw[`obj:${ref}`];
    let body;
    if (value.stream) {
      const data = Buffer.from(value.stream.data, 'base64');
      body = Buffer.concat([
        Buffer.from(
          `${serialize({ ...value.stream.dict, '/Length': data.length }, roles.get(ref))}\nstream\n`,
        ),
        data,
        Buffer.from('\nendstream'),
      ]);
    } else body = Buffer.from(serialize(value.value, roles.get(ref)));
    const object = Buffer.concat([Buffer.from(`${id} 0 obj\n`), body, Buffer.from('\nendobj\n\n')]);
    offsets.push(offset);
    pieces.push(object);
    offset += object.length;
  }
  pieces.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((at) => `${String(at).padStart(10, '0')} 00000 n \n`)
        .join('')}\ntrailer\n${serialize(trailer, 'trailer')}\n\nstartxref\n${offset}\n%%EOF`,
    ),
  );
  assert(Buffer.concat(pieces).equals(bytes), 'Noncanonical bytes or obsolete history');
  return {
    profile: 'raster-v1',
    objects: used.size,
    pages: expected.pages.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    independentlyAllowlisted: true,
  };
};
