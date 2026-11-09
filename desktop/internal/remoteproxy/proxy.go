// Package remoteproxy 把**远端 API** 转发到本机路径 `/desktop/remote-api/`，
// 供客户端里的「网站设置」页面直接调用（保存也走它）。
//
// 为什么不直接把远程地址给前端：远程用 cookie 会话，而桌面壳手里只有令牌
// （本地模式没有登录页，用户从未在远端浏览器登录过）。代理负责三件事：
//
//  1. 给请求注入 `Authorization: Bearer <令牌>`，401 时刷新令牌并重试一次；
//  2. 不转发本机壳自己的 cookie；
//  3. 禁用缓存——设置页永远读最新值。
//
// 只挂在本地回环服务上，随客户端生命周期存在，不额外开端口。
package remoteproxy

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
)

// Prefix 是挂载路径；前端用 `/desktop/remote-api/<资源>` 访问远端同名接口。
const Prefix = "/desktop/remote-api/"

// remotePathPrefix 是远端接口的真实前缀。
const remotePathPrefix = "/api/v1"

// maxBodyBytes 是重试时可缓冲的请求体上限：设置页都是小 JSON，4MB 足够。
const maxBodyBytes = 4 << 20

// Handler 返回转发到 serverURL 的处理器。
func Handler(client *cloud.Client, serverURL string, log *slog.Logger) (http.Handler, error) {
	target, err := url.Parse(serverURL)
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = slog.Default()
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	original := proxy.Director
	proxy.Director = func(req *http.Request) {
		original(req)
		req.Host = target.Host
		// /desktop/remote-api/settings → /api/v1/settings
		rest := strings.TrimPrefix(req.URL.Path, Prefix)
		req.URL.Path = remotePathPrefix + "/" + rest
		req.URL.RawPath = ""
		req.Header.Del("Cookie")
		if token := client.Session().AccessToken; token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		resp.Header.Set("Cache-Control", "no-store")
		return nil
	}
	proxy.Transport = &authTransport{base: http.DefaultTransport, client: client, log: log}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Warn("remote api: request failed", "path", r.URL.Path, "err", err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{"code":"REMOTE_UNAVAILABLE","message":"服务器暂时不可用"}}`))
	}
	return proxy, nil
}

// authTransport 在收到 401 时刷新一次令牌并重试。
type authTransport struct {
	base   http.RoundTripper
	client *cloud.Client
	log    *slog.Logger
}

func (t *authTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		raw, err := io.ReadAll(io.LimitReader(req.Body, maxBodyBytes))
		if err != nil {
			return nil, err
		}
		body = raw
		_ = req.Body.Close()
		req.Body = io.NopCloser(bytes.NewReader(body))
	}
	resp, err := t.base.RoundTrip(req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		return resp, err
	}
	if err := t.client.Refresh(req.Context()); err != nil {
		t.log.Warn("remote api: token refresh failed", "err", err)
		return resp, nil
	}
	_ = resp.Body.Close()
	retry := req.Clone(req.Context())
	retry.Body = io.NopCloser(bytes.NewReader(body))
	if token := t.client.Session().AccessToken; token != "" {
		retry.Header.Set("Authorization", "Bearer "+token)
	}
	return t.base.RoundTrip(retry)
}
