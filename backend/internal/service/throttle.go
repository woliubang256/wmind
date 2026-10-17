package service

import (
	"strings"
	"sync"
	"time"
)

// LoginThrottle 实现「连续失败 N 次后锁定一段时间」。
//
// 状态放在进程内存里，与限流器同一取舍：单实例够用，多实例时每个实例各算
// 各的，实际允许的尝试次数会变成 N 倍。要跨实例一致，需要把 entries 换成
// Redis 或一张 login_attempts 表——接口只有 Locked / Fail / Reset 三个方法，
// 替换不影响调用方。
//
// 锁定维度是「IP + 账号」而不是「IP」：只按 IP 会让同一间办公室的人互相
// 连坐；只按账号则攻击者换 IP 就能绕过。
type LoginThrottle struct {
	mu          sync.Mutex
	entries     map[string]*loginAttempts
	maxFailures int
	lockFor     time.Duration
	maxKeys     int
	now         Clock
}

type loginAttempts struct {
	failures    int
	lockedUntil time.Time
	lastSeen    time.Time
}

// NewLoginThrottle 构造登录锁定器。maxFailures <= 0 时关闭锁定（测试用）。
func NewLoginThrottle(maxFailures int, lockFor time.Duration, now Clock) *LoginThrottle {
	if lockFor <= 0 {
		lockFor = 15 * time.Minute
	}
	if now == nil {
		now = SystemClock
	}
	return &LoginThrottle{
		entries:     make(map[string]*loginAttempts),
		maxFailures: maxFailures,
		lockFor:     lockFor,
		maxKeys:     100_000,
		now:         now,
	}
}

// Locked 报告该键是否处于锁定期，并返回剩余时间。
func (t *LoginThrottle) Locked(key string) (bool, time.Duration) {
	if t == nil || t.maxFailures <= 0 {
		return false, 0
	}
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, ok := t.entries[key]
	if !ok {
		return false, 0
	}
	if entry.lockedUntil.After(now) {
		return true, entry.lockedUntil.Sub(now)
	}
	// 锁定期已过：清掉计数，给用户重新开始的配额。
	if !entry.lockedUntil.IsZero() {
		delete(t.entries, key)
	}
	return false, 0
}

// Fail 记录一次失败。返回是否因此进入锁定以及锁定时长。
func (t *LoginThrottle) Fail(key string) (bool, time.Duration) {
	if t == nil || t.maxFailures <= 0 {
		return false, 0
	}
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()

	if len(t.entries) >= t.maxKeys {
		t.evictLocked(now)
	}
	entry, ok := t.entries[key]
	if !ok {
		entry = &loginAttempts{}
		t.entries[key] = entry
	}
	entry.lastSeen = now
	entry.failures++

	if entry.failures >= t.maxFailures {
		entry.lockedUntil = now.Add(t.lockFor)
		entry.failures = 0
		return true, t.lockFor
	}
	return false, 0
}

// Reset 清空该键的失败计数。登录成功后调用。
func (t *LoginThrottle) Reset(key string) {
	if t == nil || t.maxFailures <= 0 {
		return
	}
	t.mu.Lock()
	delete(t.entries, key)
	t.mu.Unlock()
}

func (t *LoginThrottle) evictLocked(now time.Time) {
	for key, entry := range t.entries {
		if entry.lockedUntil.After(now) {
			continue
		}
		if now.Sub(entry.lastSeen) > t.lockFor {
			delete(t.entries, key)
		}
	}
	if len(t.entries) >= t.maxKeys {
		for key := range t.entries {
			delete(t.entries, key)
			if len(t.entries) <= t.maxKeys/2 {
				break
			}
		}
	}
}

// loginThrottleKey 组合「来源 IP + 账号」。
//
// 账号统一转小写：否则 "Alice" 与 "alice" 会各拿一份配额，等于把锁定次数
// 翻倍。IP 为空时退化为只按账号——测试与内部调用可能没有 IP。
func loginThrottleKey(ip, identifier string) string {
	identifier = strings.ToLower(strings.TrimSpace(identifier))
	if ip == "" {
		return identifier
	}
	return ip + "|" + identifier
}
