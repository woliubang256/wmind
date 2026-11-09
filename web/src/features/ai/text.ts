import { AIFileError, AI_LIMITS } from './limits';

/** Only decode plain text. Structured text is never parsed, rendered or executed. */
export function extractText(bytes: Uint8Array): string {
  // Supported encodings use at most four bytes per Unicode character, plus a BOM.
  // Reject before decoding a large string or allocating a code-point array.
  if (bytes.byteLength > AI_LIMITS.textRunes * 4 + 4) throw new AIFileError('textLimit');

  const decode = (encoding: string) => new TextDecoder(encoding, { fatal: true }).decode(bytes);
  let text: string;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = decode('utf-16le');
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = decode('utf-16be');
    else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) text = decode('utf-8');
    else {
      try { text = decode('utf-8'); }
      catch { text = decode('gb18030'); }
    }
  } catch {
    throw new AIFileError('parse');
  }

  // Inspect the entire decoded content, not just a sample. TAB/LF/CR are text;
  // NUL and other control bytes indicate binary data or an unsupported encoding.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) throw new AIFileError('parse');
  let characters = 0;
  for (const _character of text) {
    if (++characters > AI_LIMITS.textRunes) throw new AIFileError('textLimit');
  }
  return text;
}
