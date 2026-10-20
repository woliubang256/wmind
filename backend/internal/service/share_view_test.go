package service

import (
	"strings"
	"testing"
	"time"
)

func TestViewDeduperWindow(t *testing.T) {
	clock := newTestClock(time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC))
	deduper := NewViewDeduper(30*time.Minute, clock.Now)

	if !deduper.Mark("tok|1") {
		t.Fatal("首次访问应当计数")
	}
	// 窗口内的重复访问不计数。
	clock.Advance(29 * time.Minute)
	if deduper.Mark("tok|1") {
		t.Fatal("窗口内的重复访问不该计数")
	}
	// 恰好到窗口边界之后重新计数（>= window）。
	clock.Advance(2 * time.Minute)
	if !deduper.Mark("tok|1") {
		t.Fatal("窗口过后应当重新计数")
	}
}

func TestViewDeduperKeysAreIndependent(t *testing.T) {
	clock := newTestClock(time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC))
	deduper := NewViewDeduper(30*time.Minute, clock.Now)

	if !deduper.Mark(shareViewKey("tok-a", "1.1.1.1")) {
		t.Fatal("第一个键首次访问应当计数")
	}
	if !deduper.Mark(shareViewKey("tok-b", "1.1.1.1")) {
		t.Fatal("不同令牌是不同键")
	}
	if !deduper.Mark(shareViewKey("tok-a", "2.2.2.2")) {
		t.Fatal("不同 IP 是不同键")
	}
	if deduper.Len() != 3 {
		t.Fatalf("Len = %d，期望 3", deduper.Len())
	}
}

func TestViewDeduperPrunesExpiredEntries(t *testing.T) {
	clock := newTestClock(time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC))
	deduper := NewViewDeduper(30*time.Minute, clock.Now)

	// 塞满超过上限的键，然后推进时间再插入一个新键，触发一次清理。
	for i := 0; i < maxViewDeduperEntries+10; i++ {
		deduper.Mark(strings.Repeat("k", 1) + string(rune('a'+i%26)) + string(rune(i)))
	}
	clock.Advance(31 * time.Minute)
	deduper.Mark("fresh")

	// 清理后表里只剩新插入的那条（旧条目全部过期）。
	if got := deduper.Len(); got != 1 {
		t.Fatalf("清理后 Len = %d，期望 1", got)
	}
}

func TestShareViewKeyHidesIP(t *testing.T) {
	// 键里不能出现明文 IP：这张表可能被 dump 出来排查问题。
	key := shareViewKey("tok", "203.0.113.9")
	if strings.Contains(key, "203.0.113.9") {
		t.Fatalf("键里含明文 IP：%q", key)
	}
	if !strings.HasPrefix(key, "tok|") {
		t.Fatalf("键应以令牌开头：%q", key)
	}
	// 同一个 IP 稳定映射到同一个键，否则去重会失效。
	if shareViewKey("tok", "203.0.113.9") != key {
		t.Fatal("同一 IP 的键不稳定")
	}
	// 空 IP 退化为「按令牌去重」。
	if shareViewKey("tok", "") != "tok" {
		t.Fatalf("空 IP 的键 = %q，期望 tok", shareViewKey("tok", ""))
	}
}
