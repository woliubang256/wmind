import i18n from '@/lib/i18n';
import { api } from './client';
import type { LoginResponse } from './two-factor';

interface LoginChallenge {
  challengeId: string;
  publicKey: JsonWebKey;
  expiresIn: number;
}

/** Each explicit attempt gets a new challenge. Never retry a consumed envelope. */
export async function loginWithPassword(identifier: string, password: string): Promise<LoginResponse> {
  if (globalThis.isSecureContext === false || !globalThis.crypto?.subtle) {
    throw new Error(i18n.t('auth.secureLoginUnavailable'));
  }
  const challenge = await api.post<LoginChallenge>('/auth/login/challenge', { identifier }, { auth: false });
  let encryptedPassword: string;
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge.challengeId)
      || challenge.publicKey.kty !== 'RSA' || challenge.publicKey.alg !== 'RSA-OAEP-256'
      || challenge.publicKey.d !== undefined || challenge.expiresIn <= 0) {
      throw new Error('Invalid login challenge');
    }
    const key = await crypto.subtle.importKey('jwk', challenge.publicKey,
      { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const data = await crypto.subtle.encrypt({ name: 'RSA-OAEP', label: new TextEncoder().encode(`wmind/login/v1:${challenge.challengeId}`) },
      key, new TextEncoder().encode(password));
    encryptedPassword = btoa(String.fromCharCode(...new Uint8Array(data)));
  } catch {
    throw new Error(i18n.t('auth.loginEncryptionFailed'));
  }
  return api.post<LoginResponse>('/auth/login', { identifier, challengeId: challenge.challengeId, encryptedPassword }, { auth: false });
}
