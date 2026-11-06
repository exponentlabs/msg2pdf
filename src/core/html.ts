import sanitizeHtml from 'sanitize-html';
import type { EmailAttachment, NormalizedEmail } from './email';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[a-z\d+/=\s]+$/i;
const SAFE_COLOR = /^(?:#[a-f\d]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\))$/i;
const SAFE_SIZE = /^(?:0|\d{1,4}(?:\.\d{1,3})?(?:px|pt|em|rem|%))$/;
function cid(value: string): string {
  try {
    return decodeURIComponent(value).trim().replace(/^<|>$/g, '').toLowerCase();
  } catch {
    return value.trim().replace(/^<|>$/g, '').toLowerCase();
  }
}
export function sanitizeBody(body: string, attachments: EmailAttachment[] = []): string {
  const images = new Map(
    attachments.filter((item) => item.contentId).map((item) => [cid(item.contentId), item]),
  );
  const encoded = new Map<string, string>();
  return sanitizeHtml(body, {
    allowedTags: [
      'a',
      'abbr',
      'b',
      'blockquote',
      'br',
      'caption',
      'code',
      'col',
      'colgroup',
      'dd',
      'del',
      'div',
      'dl',
      'dt',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'i',
      'img',
      'li',
      'ol',
      'p',
      'pre',
      's',
      'small',
      'span',
      'strong',
      'sub',
      'sup',
      'table',
      'tbody',
      'td',
      'tfoot',
      'th',
      'thead',
      'tr',
      'u',
      'ul',
    ],
    allowedAttributes: {
      '*': ['style', 'dir', 'title'],
      a: ['href', 'title'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan', 'align', 'valign', 'style'],
      th: ['colspan', 'rowspan', 'align', 'valign', 'style'],
      ol: ['start'],
    },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'option',
      'noscript',
      'iframe',
      'template',
      'svg',
      'math',
    ],
    allowedStyles: {
      '*': {
        color: [SAFE_COLOR],
        'background-color': [SAFE_COLOR],
        'font-family': [/^[\w\s,'"-]+$/],
        'font-size': [/^(?:[1-9]|[1-3]\d|4[0-8])(?:\.\d+)?(?:px|pt)$/],
        'font-weight': [/^(?:normal|bold|[1-9]00)$/],
        'font-style': [/^(?:normal|italic|oblique)$/],
        'text-align': [/^(?:left|right|center|justify)$/],
        'text-decoration': [/^(?:none|underline|line-through)$/],
        'white-space': [/^(?:normal|pre|pre-wrap|pre-line)$/],
        'border-collapse': [/^(?:collapse|separate)$/],
        'border-color': [SAFE_COLOR],
        'border-style': [/^(?:none|solid|dashed|dotted|double)$/],
        'border-width': [SAFE_SIZE],
        padding: [/^[\d.\s]+(?:px|pt|em|rem|%)?$/],
        width: [SAFE_SIZE],
        'max-width': [SAFE_SIZE],
        height: [SAFE_SIZE],
      },
    },
    transformTags: {
      img: (tagName, attributes) => {
        let src = attributes.src ?? '';
        if (/^cid:/i.test(src)) {
          const key = cid(src.slice(4));
          const image = images.get(key);
          if (image?.data) {
            const type = IMAGE_TYPES.has(image.contentType.toLowerCase())
              ? image.contentType.toLowerCase()
              : inferImageType(image.name);
            if (type) {
              src =
                encoded.get(key) ??
                `data:${type};base64,${Buffer.from(image.data).toString('base64')}`;
              encoded.set(key, src);
              image.inline = true;
            }
          }
        }
        return { tagName, attribs: { ...attributes, src: DATA_IMAGE.test(src) ? src : '' } };
      },
    },
    enforceHtmlBoundary: false,
  });
}
function inferImageType(name: string): string | null {
  const extension = name.split('.').at(-1)?.toLowerCase();
  return extension
    ? ((
        {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
          bmp: 'image/bmp',
        } as Record<string, string>
      )[extension] ?? null)
    : null;
}
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export function buildEmailHtml(message: NormalizedEmail, pageSize: 'A4' | 'Letter' = 'A4'): string {
  const row = (label: string, value: string): string =>
    `<tr><th>${label}</th><td>${escapeHtml(value)}</td></tr>`;
  const ordinary = message.attachments.filter(
    (attachment) => !attachment.hidden && !attachment.inline,
  );
  const body = message.html
    ? sanitizeBody(message.html)
    : `<div class="plain">${escapeHtml(message.text || '(empty message body)')}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; script-src 'none'"><title>${escapeHtml(message.subject || '(no subject)')}</title><style>
    @page{size:${pageSize};margin:18mm 16mm}*{box-sizing:border-box}html,body{margin:0;padding:0}body{font:10.5pt/1.5 Arial,Helvetica,sans-serif;color:#202824}h1{font-size:19pt;line-height:1.25;margin:0 0 14pt;overflow-wrap:anywhere}.metadata{width:100%;border-collapse:collapse;font-size:9pt}.metadata th{width:70px;color:#67726b;text-align:left;vertical-align:top;font-weight:500}.metadata td{padding:2pt 0;overflow-wrap:anywhere}.document-header{padding-bottom:15pt;border-bottom:1px solid #dbe1dd;margin-bottom:18pt}.section-label{font-size:8pt;font-weight:700;color:#67726b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8pt}.email-body{overflow:hidden;overflow-wrap:anywhere;display:flow-root}.email-body img{max-width:100%;height:auto}.email-body table{max-width:100%}.plain{white-space:pre-wrap}.attachments{margin-top:18pt;border-top:1px solid #dbe1dd;padding-top:12pt}.attachments li{overflow-wrap:anywhere}a{color:#23674f;overflow-wrap:anywhere}@media screen{body{padding:24px}}
    </style></head><body><header class="document-header"><h1>${escapeHtml(message.subject || '(no subject)')}</h1><table class="metadata">${row('From', message.sender)}${row('To', message.recipients)}${message.cc ? row('Cc', message.cc) : ''}${row('Sent', message.sentAt)}</table></header><div class="section-label">Message</div><section class="email-body">${body}</section>${ordinary.length ? `<section class="attachments"><div class="section-label">Attachments · ${ordinary.length}</div><ul>${ordinary.map((attachment) => `<li>${escapeHtml(attachment.name)}</li>`).join('')}</ul></section>` : ''}</body></html>`;
}
