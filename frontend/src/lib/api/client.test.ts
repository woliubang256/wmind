import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, getAccessToken, setAccessToken, setUnauthorizedHandler } from './client';

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
  setUnauthorizedHandler(undefined);
});

describe('apiRequest', () => {
  it('unwraps the standard data envelope and adds the bearer token', async () => {
    setAccessToken('access-token');
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: { value: 42 }, requestId: 'req-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest<{ value: number }>('/ping')).resolves.toEqual({ value: 42 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/ping',
      expect.objectContaining({ headers: expect.any(Headers), credentials: 'include' }),
    );
    expect(((fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers).get('Authorization')).toBe('Bearer access-token');
  });

  it('maps backend error codes to stable localized messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, {
      error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'backend text' }, requestId: 'req-2',
    })));

    await expect(apiRequest('/auth/login', { method: 'POST', body: { password: 'x' }, auth: false }))
      .rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS', status: 401, message: '账号或密码错误。' });
  });

  it('refreshes a 401 once and retries with the new access token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } }))
      .mockResolvedValueOnce(json(200, { data: { accessToken: 'fresh-token' } }))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest<{ ok: boolean }>('/private')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getAccessToken()).toBe('fresh-token');
    expect(((fetchMock.mock.calls[2]?.[1] as RequestInit).headers as Headers).get('Authorization')).toBe('Bearer fresh-token');
  });

  it('calls the unauthorized handler when refresh fails', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, {
      error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' },
    })));

    await expect(apiRequest('/private')).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('returns undefined for 204 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiRequest('/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});
