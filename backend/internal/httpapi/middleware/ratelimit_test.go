package middleware

import (
	"testing"
	"time"
)

func TestRateLimiterBurstRefillAndIsolation(t *testing.T) {
	now := time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)
	limiter := NewRateLimiter(3, time.Hour, 3)
	limiter.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if allowed, _ := limiter.Allow("203.0.113.1"); !allowed {
			t.Fatalf("第 %d 次请求被拒; 配额应为 3", i+1)
		}
	}

	allowed, retryAfter := limiter.Allow("203.0.113.1")
	if allowed {
		t.Fatal("第 4 次请求应被拒绝")
	}
	// 3 次/小时 → 补一个令牌需要 20 分钟。
	if retryAfter < 19*time.Minute || retryAfter > 21*time.Minute {
		t.Fatalf("retryAfter = %v; 期望约 20 分钟", retryAfter)
	}

	// 其它键不受影响。
	if allowed, _ := limiter.Allow("203.0.113.2"); !allowed {
		t.Fatal("不同来源应各有独立配额")
	}

	// 一小时后配额恢复。
	now = now.Add(time.Hour)
	if allowed, _ := limiter.Allow("203.0.113.1"); !allowed {
		t.Fatal("一小时配额应已恢复")
	}
}

func TestRateLimiterDefaults(t *testing.T) {
	// 非法参数不应 panic，而是退化为一个可用配置。
	limiter := NewRateLimiter(0, 0, 0)
	if allowed, _ := limiter.Allow("k"); !allowed {
		t.Fatal("默认配置首次请求应放行")
	}
}

func TestBearerToken(t *testing.T) {
	cases := map[string]string{
		"Bearer abc":  "abc",
		"bearer abc":  "abc",
		"BEARER abc":  "abc",
		"Bearer  abc": "abc",
		"Basic abc":   "",
		"Bearer":      "",
		"Bearer ":     "",
		"":            "",
	}
	for header, want := range cases {
		if got := BearerToken(header); got != want {
			t.Fatalf("BearerToken(%q) = %q; 期望 %q", header, got, want)
		}
	}
}
