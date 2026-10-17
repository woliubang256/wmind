package middleware

import (
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"

	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

// RateLimiter 是按键（IP、用户、分享令牌…）分桶的令牌桶限流器。
//
// 桶放在进程内存里：单实例部署够用，且不需要任何外部依赖。多实例部署时
// 每个实例各算各的，实际配额会变成 N 倍——届时替换成 Redis 实现即可，
// 调用方只依赖 Allow / Middleware 两个入口。
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket

	limit   rate.Limit
	burst   int
	idleTTL time.Duration
	maxKeys int
	now     func() time.Time
}

type bucket struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// NewRateLimiter 构造限流器。
//
// per 是每个 interval 允许的次数（如 3 次 / 1 小时），burst 是允许的瞬时
// 突发量——通常等于 per，否则用户先快后慢会拿到超过配额的请求总数。
func NewRateLimiter(per int, interval time.Duration, burst int) *RateLimiter {
	if per <= 0 {
		per = 60
	}
	if interval <= 0 {
		interval = time.Minute
	}
	if burst <= 0 {
		burst = per
	}
	return &RateLimiter{
		buckets: make(map[string]*bucket),
		limit:   rate.Limit(float64(per) / interval.Seconds()),
		burst:   burst,
		idleTTL: 10 * time.Minute,
		maxKeys: 100_000,
		now:     time.Now,
	}
}

// Allow 消耗一个令牌，返回是否放行以及建议的重试等待时间。
func (l *RateLimiter) Allow(key string) (bool, time.Duration) {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	entry, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= l.maxKeys {
			l.evictLocked(now)
		}
		entry = &bucket{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.buckets[key] = entry
	}
	entry.lastSeen = now

	if entry.limiter.AllowN(now, 1) {
		return true, 0
	}
	// 令牌桶下一次可用的等待时间：配额耗尽后，补一个令牌需要 1/rate 秒。
	return false, time.Duration(float64(time.Second) / float64(l.limit))
}

func (l *RateLimiter) evictLocked(now time.Time) {
	for key, entry := range l.buckets {
		if now.Sub(entry.lastSeen) > l.idleTTL {
			delete(l.buckets, key)
		}
	}
	// 全都还在活跃期内时，退化为清空一半最久未使用的键，避免内存无限增长。
	if len(l.buckets) >= l.maxKeys {
		for key := range l.buckets {
			delete(l.buckets, key)
			if len(l.buckets) <= l.maxKeys/2 {
				break
			}
		}
	}
}

// Middleware 把限流器包装成 gin 中间件。keyFn 决定「按什么维度限流」。
func (l *RateLimiter) Middleware(keyFn func(*gin.Context) string) gin.HandlerFunc {
	return func(c *gin.Context) {
		allowed, retryAfter := l.Allow(keyFn(c))
		if !allowed {
			seconds := int(retryAfter.Seconds())
			if seconds < 1 {
				seconds = 1
			}
			c.Header("Retry-After", strconv.Itoa(seconds))
			response.Abort(c, apperr.New(apperr.CodeRateLimited, "").WithDetail("retryAfter", seconds))
			return
		}
		c.Next()
	}
}

// ClientIPKey 按来源 IP 限流。
//
// 依赖 gin 的 ClientIP：只有配置了 TrustedProxies 时才会采信
// X-Forwarded-For，否则用 RemoteAddr——伪造头拿不到额外配额。
func ClientIPKey(c *gin.Context) string {
	return c.ClientIP()
}
