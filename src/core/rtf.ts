import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import iconv from 'iconv-lite';
import { DeEncapsulate, deEncapsulateSync, Tokenize } from 'rtf-stream-parser';
import { LIMITS } from './limits';

interface RtfToken {
  type: number;
  word?: string;
}
const BINARY_DESTINATIONS = new Set(['pict', 'object', 'objdata', 'shp', 'shpinst', 'shprslt']);

/** Encapsulated HTML retains formatting; ordinary RTF receives a text fallback. */
export async function decodeRtfBody(raw: Buffer): Promise<{ html: string; text: string }> {
  if (raw.byteLength > LIMITS.bodyBytes) throw new Error('RTF body exceeds the 10 MiB limit');
  const header = /^\{\\rtf\d+\b/.exec(raw.subarray(0, 64).toString('latin1'));
  if (!header) throw new Error('Invalid RTF body');
  if (/\\from(?:html\d*|text)\b/.test(raw.subarray(0, 1024).toString('latin1'))) {
    const result = deEncapsulateSync(raw, { decode: iconv.decode, maxTokenSize: LIMITS.bodyBytes });
    const text = typeof result.text === 'string' ? result.text : iconv.decode(result.text, 'utf8');
    return result.mode === 'html' ? { html: text, text: '' } : { html: '', text };
  }
  // Select the library's plain-text output path for ordinary RTF. Tokenization
  // still handles nesting, Unicode fallback bytes, escaped braces and codepages.
  const marked = Buffer.concat([
    raw.subarray(0, header[0].length),
    Buffer.from('\\fromtext '),
    raw.subarray(header[0].length),
  ]);
  const stack: boolean[] = [];
  const filter = new Transform({
    objectMode: true,
    transform(token: RtfToken, _encoding, done) {
      if (token.type === 0) {
        stack.push(stack.at(-1) ?? false);
        done(null, token);
        return;
      }
      if (token.type === 1) {
        stack.pop();
        done(null, token);
        return;
      }
      if (token.type === 2 && token.word && BINARY_DESTINATIONS.has(token.word) && stack.length)
        stack[stack.length - 1] = true;
      done(null, stack.at(-1) ? undefined : token);
    },
  });
  const decoded = new DeEncapsulate({ decode: iconv.decode });
  const chunks: string[] = [];
  let bytes = 0;
  decoded.on('data', (chunk: string | Buffer) => {
    const text = chunk.toString();
    bytes += Buffer.byteLength(text);
    if (bytes > LIMITS.bodyBytes)
      decoded.destroy(new Error('Decoded RTF exceeds the 10 MiB limit'));
    else chunks.push(text);
  });
  await pipeline(
    Readable.from([marked]),
    new Tokenize({ maxTokenSize: LIMITS.bodyBytes }),
    filter,
    decoded,
  );
  return { html: '', text: chunks.join('') };
}
