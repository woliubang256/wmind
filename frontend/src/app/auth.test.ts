import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCurrentUser } from './auth';
import { getAccessToken, setAccessToken, setUnauthorizedHandler, type AuthSession } from '@/lib/api/client';

const session: AuthSession = {
  accessToken: 'restored-token', expiresIn: 900,
  user: { uid: 'user-1', username: 'alice', email: 'alice@example.test', nickname: 'Alice', avatarUrl: '', role: 'user', status: 'active' },
};
const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
  status, headers: { 'Content-Type': 'application/json' },
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
  setUnauthorizedHandler(undefined);
});

describe('页面会话初始化', () => {
  it('刷新页面直接恢复 Cookie 会话，不先发送必然 401 的 me，也不重复查询用户', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/refresh')) return json(200, { data: session });
      if ((init?.headers as Headers).get('Authorization') === `Bearer ${session.accessToken}`) return json(200, { data: session.user });
      return json(401, { error: { code: 'AUTH_TOKEN_INVALID', message: 'missing token' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadCurrentUser()).resolves.toEqual(session.user);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/auth/refresh']);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/refresh', expect.objectContaining({ method: 'POST', credentials: 'include' }));
    expect(getAccessToken()).toBe(session.accessToken);
  });

  it('已有内存令牌时直接查询 me，不为页面内的用户刷新再次轮换', async () => {
    setAccessToken('existing-token');
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: session.user }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadCurrentUser()).resolves.toEqual(session.user);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/me');
    expect((fetchMock.mock.calls[0]?.[1].headers as Headers).get('Authorization')).toBe('Bearer existing-token');
  });

  it.each([401, 403])('无有效会话或账号禁用（%s）时不再请求 me', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(json(status, { error: { code: 'AUTH_REFRESH_INVALID', message: 'invalid session' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadCurrentUser()).resolves.toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/auth/refresh']);
    expect(getAccessToken()).toBeNull();
  });

  it('并发初始化共享一次刷新', async () => {
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json(200, { data: session });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(Promise.all([loadCurrentUser(), loadCurrentUser(), loadCurrentUser()]))
      .resolves.toEqual([session.user, session.user, session.user]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('网络失败不会被当作未登录吞掉', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(loadCurrentUser()).rejects.toThrow();
    expect(getAccessToken()).toBeNull();
  });

  it('服务端暂时失败不会被当作未登录吞掉', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'unavailable' } })));
    await expect(loadCurrentUser()).rejects.toMatchObject({ status: 503 });
  });
});
