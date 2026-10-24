import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiList, apiRequest, getAccessToken, refreshSession, setAccessToken, setUnauthorizedHandler, type AuthSession } from './client';

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const session = (accessToken: string): AuthSession => ({
  accessToken, expiresIn: 900,
  user: { uid: 'user-1', username: 'alice', email: '', nickname: 'Alice', avatarUrl: '', role: 'user', status: 'active' },
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
      .mockResolvedValueOnce(json(200, { data: session('fresh-token') }))
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
    vi.stubGlobal('fetch', vi.fn(async () => json(401, {
      error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' },
    })));

    await expect(apiRequest('/private')).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('returns undefined for 204 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiRequest('/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('merges concurrent 401 refreshes into a single refresh request', async () => {
    // 验收标准 5 的后半句：多个并发请求只触发一次刷新。
    // 刷新令牌是一次性轮换的，并发刷新会让后到的请求把前一个刚换来的令牌
    // 判成重放，整条会话被撤销。
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        // 故意延迟，让三个请求都有机会在刷新完成前拿到 401。
        await new Promise((resolve) => setTimeout(resolve, 5));
        return json(200, { data: session('shared-token') });
      }
      const headers = init?.headers as Headers | undefined;
      if (headers?.get('Authorization') === 'Bearer shared-token') {
        return json(200, { data: { path: url } });
      }
      return json(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([
      apiRequest<{ path: string }>('/a'),
      apiRequest<{ path: string }>('/b'),
      apiRequest<{ path: string }>('/c'),
    ]);

    expect(refreshCalls).toBe(1);
    expect(results.map((r) => r.path)).toEqual(['/api/v1/a', '/api/v1/b', '/api/v1/c']);
  });

  it('keeps pagination out of the way for plain requests and returns it for lists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, {
      data: [{ uid: 'a' }, { uid: 'b' }],
      pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
    })));

    await expect(apiList<{ uid: string }>('/admin/users')).resolves.toEqual({
      items: [{ uid: 'a' }, { uid: 'b' }],
      pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
    });
  });

  it('shares one refresh between session initialization and a protected request', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/refresh')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return json(200, { data: session('shared-token') });
      }
      return (init?.headers as Headers).get('Authorization') === 'Bearer shared-token'
        ? json(200, { data: { ok: true } })
        : json(401, { error: { code: 'AUTH_TOKEN_INVALID', message: 'missing token' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(Promise.all([refreshSession(), apiRequest('/private')]))
      .resolves.toEqual([session('shared-token'), { ok: true }]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
    const refreshInit = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/auth/refresh'))?.[1];
    expect((refreshInit?.headers as Headers).has('Authorization')).toBe(false);
  });

  it('reuses an updated token when an old-token 401 arrives after refresh completes', async () => {
    setAccessToken('old-token');
    let releaseLate!: () => void;
    const late = new Promise<void>((resolve) => { releaseLate = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) return json(200, { data: session('fresh-token') });
      if ((init?.headers as Headers).get('Authorization') === 'Bearer fresh-token') return json(200, { data: { ok: true } });
      if (url.endsWith('/late')) await late;
      return json(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = apiRequest('/late');
    await expect(apiRequest('/fast')).resolves.toEqual({ ok: true });
    releaseLate();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('does not log out on a transient refresh server error', async () => {
    setAccessToken('existing-token');
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } }))
      .mockResolvedValueOnce(json(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'unavailable' } })));
    await expect(apiRequest('/private')).rejects.toMatchObject({ status: 503 });
    expect(getAccessToken()).toBe('existing-token');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it.each([null, {}, { accessToken: 'token' }, { ...session('token'), user: null }, session('')])
    ('rejects an incomplete refresh response without installing a token (%j)', async (payload) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { data: payload })));
      await expect(refreshSession()).rejects.toThrow();
      expect(getAccessToken()).toBeNull();
    });

  it('does not loop if the retried request is still unauthorized', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/auth/refresh')
      ? json(200, { data: session('fresh-token') })
      : json(401, { error: { code: 'AUTH_TOKEN_INVALID', message: 'invalid' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/private')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
