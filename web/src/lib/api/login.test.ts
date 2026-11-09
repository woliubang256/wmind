import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loginWithPassword } from './login';

const id = 'a'.repeat(43);
let keys: CryptoKeyPair;
let publicKey: JsonWebKey;
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } });

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('encrypted password login', () => {
  it.each(['existing-password', '中文密码123', 'a'.repeat(72)])('only sends an OAEP envelope for %s', async (password) => {
    const session = { accessToken: 'test-session', expiresIn: 900, user: { uid: 'user' } };
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ challengeId: id, publicKey, expiresIn: 120 })).mockResolvedValueOnce(response(session));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loginWithPassword('alice', password)).resolves.toEqual(session);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/auth/login/challenge');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ identifier: 'alice' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/auth/login');
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'encryptedPassword', 'identifier']);
    expect(body.encryptedPassword).not.toBe(password);
    const bytes = Uint8Array.from(atob(body.encryptedPassword), c => c.charCodeAt(0));
    const decoded = await crypto.subtle.decrypt({ name: 'RSA-OAEP', label: new TextEncoder().encode(`wmind/login/v1:${id}`) }, keys.privateKey, bytes);
    expect(new TextDecoder().decode(decoded)).toBe(password);
    await expect(crypto.subtle.decrypt({ name: 'RSA-OAEP', label: new TextEncoder().encode('other-challenge') }, keys.privateKey, bytes)).rejects.toThrow();
  });

  it('gets a fresh challenge for every attempt and produces randomized ciphertext', async () => {
    const envelopes: string[] = [];
    let challenges = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/challenge')) { challenges++; return response({ challengeId: (challenges === 1 ? 'a' : 'b').repeat(43), publicKey, expiresIn: 120 }); }
      envelopes.push(JSON.parse(init.body as string).encryptedPassword);
      return response({ twoFactorRequired: true, challengeToken: 'second-factor-only', expiresIn: 300 });
    }));
    await expect(loginWithPassword('alice', 'password')).resolves.toMatchObject({ twoFactorRequired: true });
    await loginWithPassword('alice', 'password');
    expect(challenges).toBe(2);
    expect(envelopes[0]).not.toBe(envelopes[1]);
  });

  it.each(['insecure context', 'missing Web Crypto'])('fails without a network request for %s', async (condition) => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    if (condition === 'insecure context') vi.stubGlobal('isSecureContext', false);
    else vi.stubGlobal('crypto', undefined);
    await expect(loginWithPassword('alice', 'password')).rejects.toThrow('HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never falls back to plaintext when public-key import fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ challengeId: id, publicKey: { ...publicKey, n: 'invalid' }, expiresIn: 120 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loginWithPassword('alice', 'password')).rejects.toThrow('加密失败');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not replay a login after a network failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ challengeId: id, publicKey, expiresIn: 120 })).mockRejectedValueOnce(new TypeError('network error'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loginWithPassword('alice', 'password')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
