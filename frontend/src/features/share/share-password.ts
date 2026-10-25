const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Sharing is independent of account-password policy. Never use a weak fallback. */
export function generateSharePassword(): string {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random unavailable');
  const byte = new Uint8Array(1);
  const limit = 256 - (256 % ALPHABET.length);
  const character = () => {
    for (let attempt = 0; attempt < 128; attempt++) {
      crypto.getRandomValues(byte);
      if (byte[0] < limit) return ALPHABET[byte[0] % ALPHABET.length];
    }
    throw new Error('Secure random unavailable');
  };
  // Rejection preserves uniform sampling among four-character, three-class passwords.
  for (let attempt = 0; attempt < 256; attempt++) {
    const password = Array.from({ length: 4 }, character).join('');
    if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password)) return password;
  }
  throw new Error('Secure random unavailable');
}

/** Also supports self-hosted insecure contexts where Clipboard API is absent. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Permission denied: try the selection-based fallback. */ }
  const area = document.createElement('textarea');
  const active = document.activeElement;
  try {
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    // An active native dialog makes body children inert, so copy inside it.
    (Array.from(document.querySelectorAll('dialog[open]')).at(-1) ?? document.body).appendChild(area);
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  }
}
