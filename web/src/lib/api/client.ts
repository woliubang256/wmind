import i18n from '@/lib/i18n';
import { ApiError, type ApiErrorEnvelope } from './errors';
import type { Paged, Pagination } from './types';

/**
 * 桌面壳注入的运行时配置（`window.__WMIND__`）。Web 形态下不存在，
 * 因此下面的读取必须容忍 undefined。
 *
 * 桌面本地模式没有登录页：壳在首屏 HTML 里注入一个长期访问令牌，前端
 * 直接拿它调接口；`apiBase` 也由壳给出，前端不再假设自己跑在站点根路径。
 */
interface DesktopRuntime {
  mode?: 'local' | 'cloud';
  version?: string;
  apiBase?: string;
  authToken?: string;
}

declare global {
  interface Window {
    __WMIND__?: DesktopRuntime;
  }
}

const desktopRuntime = typeof window === 'undefined' ? undefined : window.__WMIND__;

const API_BASE = desktopRuntime?.apiBase ?? '/api/v1';
let accessToken: string | null = desktopRuntime?.authToken ?? null;
let onUnauthorized: (() => void) | undefined;
let refreshInFlight: Promise<AuthSession | null> | null = null;
let sessionGeneration = 0;

export function setAccessToken(token: string | null) {
  sessionGeneration += 1;
  refreshInFlight = null;
  accessToken = token;
}

function endSession(generation: number) {
  if (generation !== sessionGeneration) return;
  setAccessToken(null);
  onUnauthorized?.();
}

export function getAccessToken() {
  return accessToken;
}

export function setUnauthorizedHandler(handler: (() => void) | undefined) {
  onUnauthorized = handler;
}

interface ApiEnvelope<T> {
  data: T;
  pagination?: Pagination;
  requestId?: string;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | object | null;
  auth?: boolean;
  retryAuth?: boolean;
  /**
   * 覆盖接口根路径。
   *
   * 桌面端「网站设置」要读写**服务器**的配置，而不是本机的：它走
   * `/desktop/remote-api`，由本机后端把请求转发到远端（注入令牌、刷新重试）。
   * 用显式参数而不是全局变量——全局切换会让同时在跑的其它请求串到远端去。
   */
  base?: string;
}

/**
 * 启动恢复与运行中的令牌刷新共用同一会话请求。
 *
 * 单例 Promise 是这里的关键：多个请求同时拿到 401 时，只有第一个真正发出
 * 刷新请求，其余的都等同一个 Promise。没有这一层，一次页面加载里五六个
 * 并发请求会触发五六次刷新，而刷新令牌是「用一次就轮换」的——后到的几个
 * 必然失败，还会把前一个刚换来的令牌判成「重放」并撤销整条会话。
 */
export async function refreshSession(): Promise<AuthSession | null> {
  if (refreshInFlight) return refreshInFlight;
  const generation = sessionGeneration;
  const pending = (async () => {
    try {
      const session = await apiRequest<AuthSession>('/auth/refresh', {
        method: 'POST',
        auth: false,
        retryAuth: false,
      });
      if (generation !== sessionGeneration) return null;
      if (typeof session?.accessToken !== 'string' || session.accessToken.length === 0
        || typeof session.user?.uid !== 'string' || session.user.uid.length === 0) {
        throw new Error(i18n.t('network.invalidBody'));
      }
      accessToken = session.accessToken;
      return session;
    } catch (error) {
      if (generation !== sessionGeneration) return null;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        accessToken = null;
        return null;
      }
      // 断网、5xx 和响应损坏不等于会话失效，不清令牌或跳转登录。
      throw error;
    } finally {
      if (generation === sessionGeneration) refreshInFlight = null;
    }
  })();
  refreshInFlight = pending;
  return pending;
}

function isBodyInit(body: RequestOptions['body']): body is BodyInit {
  return (
    typeof body === 'string' ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

async function requestEnvelope<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
  const { auth = true, retryAuth = true, headers: inputHeaders, body, base = API_BASE, ...init } = options;
  const headers = new Headers(inputHeaders);
  headers.set('Accept', 'application/json');
  let requestBody: BodyInit | null | undefined;
  if (body === undefined || body === null) {
    requestBody = body;
  } else if (isBodyInit(body)) {
    requestBody = body;
  } else {
    headers.set('Content-Type', 'application/json');
    requestBody = JSON.stringify(body);
  }
  const requestToken = auth ? accessToken : null;
  const generation = sessionGeneration;
  if (requestToken) headers.set('Authorization', `Bearer ${requestToken}`);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      body: requestBody,
      headers,
      credentials: 'include',
    });
  } catch (cause) {
    throw new Error(i18n.t('network.offline'), { cause });
  }

  if (response.status === 204) return { data: undefined as T };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(i18n.t('network.unreadable', { status: response.status }));
  }
  const errorPayload = payload as ApiErrorEnvelope;

  // A sensitive action may reject the password supplied for that action while
  // the bearer session remains valid. Do not refresh or log out that session.
  if (response.status === 401 && auth && errorPayload?.error?.code !== 'AUTH_INVALID_CREDENTIALS') {
    if (retryAuth && path !== '/auth/refresh' && generation === sessionGeneration) {
      // 较慢的旧请求可能在刷新完成后才返回 401，直接复用新令牌，不再轮换。
      const token = accessToken && accessToken !== requestToken
        ? accessToken
        : (await refreshSession())?.accessToken;
      if (token && generation === sessionGeneration) {
        return requestEnvelope<T>(path, { ...options, retryAuth: false });
      }
    }
    endSession(generation);
  }

  if (!response.ok) {
    if (auth && response.status === 403 && errorPayload?.error?.code === 'AUTH_ACCOUNT_DISABLED') {
      endSession(generation);
    }
    if (errorPayload?.error?.code && errorPayload.error.message) {
      throw new ApiError(errorPayload, response.status);
    }
    throw new Error(i18n.t('network.failed', { status: response.status }));
  }

  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new Error(i18n.t('network.invalidBody'));
  }
  return payload as ApiEnvelope<T>;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const envelope = await requestEnvelope<T>(path, options);
  return envelope.data;
}

/**
 * 请求一个列表接口，返回 `{items, pagination}`。
 *
 * 单独一个函数是因为分页信息在信封的 `pagination` 字段里，而 `apiRequest`
 * 只取 `data`。让 `apiRequest` 也能返回分页会把返回类型变成联合类型，
 * 每个调用点都要判断。
 */
export async function apiList<T>(path: string, options: RequestOptions = {}): Promise<Paged<T>> {
  const envelope = await requestEnvelope<T[]>(path, options);
  return {
    items: envelope.data ?? [],
    pagination: envelope.pagination ?? { page: 1, pageSize: envelope.data?.length ?? 0, total: envelope.data?.length ?? 0, totalPages: 1 },
  };
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: RequestOptions['body'], options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: RequestOptions['body'], options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: RequestOptions['body'], options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
  list: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiList<T>(path, { ...options, method: 'GET' }),
};

export interface CurrentUser {
  uid: string;
  username: string;
  email: string;
  nickname: string;
  avatarUrl: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  mapCount?: number;
}

export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  user: CurrentUser;
}
