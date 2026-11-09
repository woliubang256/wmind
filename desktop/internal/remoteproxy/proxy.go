// Package remoteproxy 在回环地址上跑一个反向代理，把**云端服务器**的 Web 界面
// 搬进客户端窗口（iframe 里）。
//
// 为什么不直接把远程地址塞进 iframe：远程用的是 cookie 会话，而桌面壳手里只有
// 令牌（本地模式没有登录页，用户从未在远端浏览器里登录过）。所以代理做三件事：
//
//  1. 给 /api 请求注入 `Authorization: Bearer <令牌>`，令牌过期时自动刷新重试一次；
//  2. 把远端的 Set-Cookie 改写成回环地址的 cookie（去掉 Domain），让远程页面
//     自己的刷新流程在 iframe 里也能走通；
//  3. 去掉 X-Frame-Options / CSP 的 frame-ancestors，并禁掉缓存——否则远程站点
//     默认拒绝被嵌入，iframe 一片空白。
//
// 代理只监听 127.0.0.1 的随机端口，且只在用户已连接云端时启动。
package remoteproxy

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
)

// maxBodyBytes 是重试时可缓冲的请求体上限：设置页都是小 JSON，4MB 足够。
const maxBodyBytes = 4 << 20

// Server 是运行中的代理。
type Server struct {
	ln     net.Listener
	srv    *http.Server
	client *cloud.Client
}

// Start 起一个代理指向 serverURL，并返回它。
func Start(ctx context.Context, client *cloud.Client, serverURL string, log *slog.Logger) (*Server, error) {
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
		// 只转发远端自己的 cookie（远程会话的刷新靠它），不把本机壳的 cookie 带出去。
		if cookie := stripDesktopCookie(req.Header.Get("Cookie")); cookie != "" {
			req.Header.Set("Cookie", cookie)
		} else {
			req.Header.Del("Cookie")
		}
		if token := client.Session().AccessToken; token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		resp.Header.Del("X-Frame-Options")
		resp.Header.Del("Content-Security-Policy")
		resp.Header.Set("Cache-Control", "no-store")
		if cookies := resp.Header.Values("Set-Cookie"); len(cookies) > 0 {
			resp.Header.Del("Set-Cookie")
			for _, cookie := range cookies {
				resp.Header.Add("Set-Cookie", loopbackCookie(cookie))
			}
		}
		return nil
	}
	proxy.Transport = &authTransport{base: http.DefaultTransport, client: client, log: log}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Warn("remote proxy: request failed", "path", r.URL.Path, "err", err)
		w.WriteHeader(http.StatusBadGateway)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	srv := &http.Server{Handler: proxy, ReadHeaderTimeout: 15e9}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Warn("remote proxy: serve stopped", "err", err)
		}
	}()
	return &Server{ln: ln, srv: srv, client: client}, nil
}

// URL 返回代理的根地址（结尾不带斜杠）。
func (s *Server) URL() string {
	if s == nil {
		return ""
	}
	return "http://" + s.ln.Addr().String()
}

// Close 停掉代理。
func (s *Server) Close() {
	if s == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = s.srv.Shutdown(ctx)
}

// stripDesktopCookie 去掉桌面壳自己的 cookie，只留远端的。
func stripDesktopCookie(header string) string {
	parts := strings.Split(header, ";")
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		item := strings.TrimSpace(part)
		if item == "" || strings.HasPrefix(item, "wmind_desktop=") {
			continue
		}
		kept = append(kept, item)
	}
	return strings.Join(kept, "; ")
}

// loopbackCookie 把远端的 Set-Cookie 改写成回环地址可用的形式：去掉 Domain，
// 路径归一到根。否则浏览器会因为域名不匹配而丢弃它，远程页面的刷新就断了。
func loopbackCookie(raw string) string {
	parts := strings.Split(raw, ";")
	kept := []string{strings.TrimSpace(parts[0])}
	for _, attr := range parts[1:] {
		item := strings.TrimSpace(attr)
		switch {
		case item == "":
			continue
		case strings.HasPrefix(strings.ToLower(item), "domain="):
			continue
		case strings.HasPrefix(strings.ToLower(item), "path="):
			kept = append(kept, "Path=/")
		default:
			kept = append(kept, item)
		}
	}
	return strings.Join(kept, "; ")
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
	if err != nil || resp.StatusCode != http.StatusUnauthorized || body == nil && req.Method != http.MethodGet {
		return resp, err
	}
	if err := t.client.Refresh(req.Context()); err != nil {
		t.log.Warn("remote proxy: token refresh failed", "err", err)
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
