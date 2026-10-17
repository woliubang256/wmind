import { ApiError, type ApiErrorEnvelope } from './errors';
import type { Paged, Pagination } from './types';

const API_BASE = '/api/v1';
let accessToken: string | null = null;
let onUnauthorized: (() => void) | undefined;
let refreshInFlight: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
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
}

/**
 * 静默刷新访问令牌。
 *
 * 单例 Promise 是这里的关键：多个请求同时拿到 401 时，只有第一个真正发出
 * 刷新请求，其余的都等同一个 Promise。没有这一层，一次页面加载里五六个
 * 并发请求会触发五六次刷新，而刷新令牌是「用一次就轮换」的——后到的几个
 * 必然失败，还会把前一个刚换来的令牌判成「重放」并撤销整条会话。
 */
async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      const envelope = (await response.json()) as ApiEnvelope<{ accessToken: string }>;
      const token = envelope.data?.accessToken;
      if (typeof token !== 'string' || token.length === 0) return null;
      accessToken = token;
      return token;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
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
  const { auth = true, retryAuth = true, headers: inputHeaders, body, ...init } = options;
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
  if (auth && accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      body: requestBody,
      headers,
      credentials: 'include',
    });
  } catch (cause) {
    throw new Error('无法连接服务器，请检查网络后重试。', { cause });
  }

  if (response.status === 401 && auth && retryAuth && path !== '/auth/refresh') {
    const token = await refreshAccessToken();
    if (token) {
      return requestEnvelope<T>(path, { ...options, retryAuth: false });
    }
    accessToken = null;
    onUnauthorized?.();
  }

  if (response.status === 204) return { data: undefined as T };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`服务器返回了无法识别的响应（HTTP ${response.status}）。`);
  }

  if (!response.ok) {
    const errorPayload = payload as ApiErrorEnvelope;
    if (errorPayload?.error?.code && errorPayload.error.message) {
      throw new ApiError(errorPayload, response.status);
    }
    throw new Error(`请求失败（HTTP ${response.status}）。`);
  }

  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new Error('服务器响应格式无效。');
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
