// Package localserver 是桌面端的内层 HTTP 服务：把「前端静态资源」与
// 「后端 API」放在同一个源（http://127.0.0.1:<port>）上。
//
// 为什么要自己起一层而不是让 webview 直接指向远端服务器：
//
//   - 同源。前端的 refresh cookie、相对路径 /api/v1/*、/uploads/* 全部照旧，
//     不需要 CORS、不需要改前端代码；离线与在线是同一段前端代码。
//   - 可注入。页面加载前把 window.__WMIND__（模式、版本、令牌）写进 HTML，
//     前端据此知道自己跑在桌面壳里。
//   - 可守门。回环端口虽然只监听 127.0.0.1，但本机其它进程照样能访问，
//     所以除首屏 HTML 外，所有请求都要求带上启动时生成的令牌 cookie。
package localserver

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strings"
)

// CookieName 是桌面壳的访问令牌 cookie。
//
// 用 cookie 而不是自定义请求头：前端现有的 fetch 调用会自动带上同源
// cookie，不需要为桌面版改一行请求代码。
const CookieName = "wmind_desktop"

// Config 是内层服务的组装参数。
type Config struct {
	// API 是后端 router（gin 构造的 http.Handler）。
	API http.Handler
	// Static 是前端构建产物；为 nil 时返回内置占位页，便于在接入前端之前
	// 先把壳跑通。
	Static fs.FS
	// Token 是启动时生成的一次性令牌。
	Token string
	// Mode 注入给前端的运行模式，当前固定为 "local"。
	Mode string
	// Version 注入给前端的应用版本。
	Version string
	// AuthToken 注入给前端的访问令牌：本地模式没有登录页，前端拿它直接
	// 调 API。
	AuthToken string
	// MediaToken 是媒体会话令牌：/uploads 的图片鉴权只认它（或 Bearer），
	// 而 <img> 发不出请求头，所以由这里下发成 cookie。
	MediaToken string
	// Locale 是 mygo 解析出的界面语言（跟随系统），前端据此解析「跟随系统」。
	Locale string
	// PreferredLanguages 是系统偏好语言列表（最优先在前）。
	PreferredLanguages []string
	// Desktop 是桌面专有接口（/desktop/*：连接云端、触发同步、来源查询）。
	// 为空时不挂载——Web 形态与没有云端能力的构建都不需要它。
	Desktop http.Handler
}

// New 组装内层服务的 Handler。
func New(cfg Config) (http.Handler, error) {
	if cfg.API == nil {
		return nil, errors.New("localserver: API handler is required")
	}
	if len(cfg.Token) < 16 {
		return nil, errors.New("localserver: token is too short")
	}
	s := &server{cfg: cfg}
	mux := http.NewServeMux()
	// 后端 API 与上传资源整体转给 router：路径前缀与 Web 形态完全一致。
	mux.Handle("/api/", cfg.API)
	mux.Handle("/uploads/", cfg.API)
	if cfg.Desktop != nil {
		mux.Handle("/desktop/", cfg.Desktop)
	}
	mux.Handle("/", s.static())
	return s.guard(mux), nil
}

type server struct {
	cfg Config
}

// guard 校验令牌 cookie，并放行首屏 HTML。
//
// 首屏必须放行：浏览器首次导航时还没有 cookie，而它正是拿到 cookie 的
// 唯一机会。放行范围严格限制为「HTML 文档」——非文档请求（脚本、样式、
// API）一律要求令牌，否则守卫形同虚设。
func (s *server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isDocumentRequest(r) && !s.hasToken(r) {
			s.setToken(w)
			s.setMediaToken(w)
			next.ServeHTTP(w, r)
			return
		}
		if !s.hasToken(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) hasToken(r *http.Request) bool {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.cfg.Token)) == 1
}

func (s *server) setToken(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    s.cfg.Token,
		Path:     "/",
		HttpOnly: true,
		// 回环 http 源，不能用 Secure；SameSite=Strict 让别的站点发起的
		// 请求带不上它，本机其它进程也拿不到（cookie 不跨进程共享）。
		SameSite: http.SameSiteStrictMode,
	})
}

// setMediaToken 下发媒体会话 cookie。
//
// Path 必须是 /uploads：后端就是这么设的（登录路径），别的地方带不上它。
func (s *server) setMediaToken(w http.ResponseWriter) {
	if s.cfg.MediaToken == "" {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "wmind_media",
		Value:    s.cfg.MediaToken,
		Path:     "/uploads",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

// isDocumentRequest 判断这是不是一次「页面导航」。
//
// 两个条件都要满足，缺一不可：
//   - 请求头声明这是文档（老 webview 没有 Sec-Fetch-*，退回按路径判断）；
//   - 路径看起来是页面，而不是 API 或上传资源。
//
// 只按请求头判断是不行的：本机任何进程都能伪造 Sec-Fetch-Dest，那样守卫
// 就形同虚设；只按路径判断也不行，脚本路径也可能是无扩展名的。
func isDocumentRequest(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	path := r.URL.Path
	if strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/uploads/") {
		return false
	}
	pageLike := path == "/" || strings.HasSuffix(path, "/") ||
		strings.HasSuffix(path, ".html") || !hasExtension(path)
	if !pageLike {
		return false
	}
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" {
		return dest == "document" || dest == "iframe"
	}
	return true
}

// static 提供前端静态资源，并在 HTML 里注入运行时配置。
func (s *server) static() http.Handler {
	fileServer := http.NotFoundHandler()
	if s.cfg.Static != nil {
		fileServer = http.FileServer(http.FS(s.cfg.Static))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.Static == nil {
			s.servePlaceholder(w, r)
			return
		}
		// 无扩展名的路径交给前端路由（SPA）：返回 index.html。
		if !hasExtension(r.URL.Path) {
			s.serveIndex(w, r)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}

func (s *server) serveIndex(w http.ResponseWriter, r *http.Request) {
	f, err := s.cfg.Static.Open("index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	body, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "read index.html", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(inject(body, s.runtimeScript()))
}

func (s *server) servePlaceholder(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = fmt.Fprintf(w, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>wmind</title></head>
<body style="font:14px/1.6 -apple-system,system-ui,sans-serif;margin:3rem">
<h1 style="font-size:1.25rem">wmind 桌面壳已启动</h1>
<p>本地后端与前端构建产物尚未接入（M-D1 第 3 步）。</p>
<pre style="background:#f5f5f5;padding:1rem;border-radius:8px">%s</pre>
</body></html>`, s.runtimeScript())
}

// runtimeScript 是注入到页面里的 <script>，前端读 window.__WMIND__。
//
// 注入在首屏 HTML 里而不是用 Eval：前端模块在解析时就会读它，晚一步的
// 注入会让首次加载走成「未登录」。
func (s *server) runtimeScript() string {
	values := map[string]string{
		"mode":    s.cfg.Mode,
		"version": s.cfg.Version,
		"apiBase": "/api/v1",
	}
	if s.cfg.AuthToken != "" {
		values["authToken"] = s.cfg.AuthToken
	}
	if s.cfg.Locale != "" {
		values["locale"] = s.cfg.Locale
	}
	if len(s.cfg.PreferredLanguages) > 0 {
		values["preferredLanguages"] = strings.Join(s.cfg.PreferredLanguages, ",")
	}
	return fmt.Sprintf(`<script>window.__WMIND__=%s;</script>`, jsonObject(values))
}

// inject 把脚本插到 </head> 之前（没有 head 就插到文档开头）。
func inject(html []byte, script string) []byte {
	marker := []byte("</head>")
	if idx := indexOf(html, marker); idx >= 0 {
		out := make([]byte, 0, len(html)+len(script))
		out = append(out, html[:idx]...)
		out = append(out, script...)
		out = append(out, html[idx:]...)
		return out
	}
	return append([]byte(script), html...)
}

func indexOf(haystack, needle []byte) int {
	return strings.Index(string(haystack), string(needle))
}

func hasExtension(path string) bool {
	last := path[strings.LastIndex(path, "/")+1:]
	return strings.Contains(last, ".")
}

// jsonObject 输出稳定的 JSON 对象（键排序），避免注入内容随 map 迭代变化。
func jsonObject(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sortStrings(keys)
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%q:%q", k, values[k])
	}
	b.WriteByte('}')
	return b.String()
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// Listen 在回环地址上监听一个随机端口。
//
// 只绑 127.0.0.1：桌面端的服务不该被局域网访问。
func Listen() (net.Listener, error) {
	return net.Listen("tcp", "127.0.0.1:0")
}
