package service

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

// DefaultShareViewWindow 是访问计数的去重窗口（docs/04 §5.7）。
//
// 30 分钟的依据：分享页会周期性刷新文档（前端轮询/重新进入），一个访客在
// 半小时里反复打开同一张图，在统计上仍然是「一次访问」。没有窗口的话，
// view_count 会变成「页面刷新次数」，谁也不会拿它当参考。
const DefaultShareViewWindow = 30 * time.Minute

// maxViewDeduperEntries 是去重表的容量上限。
//
// 表里每条只有几十字节，但它是**只增不减**的：不设上限，一个被爬的站点
// 能把这几十字节乘以任意大的访问量。超过上限时整表按窗口清理一次，代价
// 是一次 O(n) 遍历，摊到每个新键上可以忽略。
const maxViewDeduperEntries = 20000

// ViewDeduper 是单实例内存实现的访问去重表。
//
// 多实例部署时它**不准确**：同一访客打到不同实例会被各记一次。这是刻意
// 接受的——准确的跨实例去重要引入 Redis，而 view_count 只是一个参考数字，
// 不值得为它加一个外部依赖。真要精确时替换成本类即可（接口只有 Mark）。
type ViewDeduper struct {
	mu     sync.Mutex
	window time.Duration
	seen   map[string]time.Time
	now    Clock
}

// NewViewDeduper 构造去重表。window <= 0 时用默认窗口。
func NewViewDeduper(window time.Duration, now Clock) *ViewDeduper {
	if window <= 0 {
		window = DefaultShareViewWindow
	}
	if now == nil {
		now = SystemClock
	}
	return &ViewDeduper{window: window, seen: make(map[string]time.Time), now: now}
}

// Mark 记录一次访问，并报告这次访问是否应当计入 view_count。
//
// 返回 true 表示「窗口内没见过这个键」——调用方才去执行 UPDATE。反过来
// （先写库再判断）会让每次刷新都产生一次写事务。
func (d *ViewDeduper) Mark(key string) bool {
	now := d.now()
	d.mu.Lock()
	defer d.mu.Unlock()
	if last, ok := d.seen[key]; ok && now.Sub(last) < d.window {
		return false
	}
	d.seen[key] = now
	if len(d.seen) > maxViewDeduperEntries {
		d.pruneLocked(now)
	}
	return true
}

// Len 返回表内条目数（测试与运维观察用）。
func (d *ViewDeduper) Len() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.seen)
}

func (d *ViewDeduper) pruneLocked(now time.Time) {
	for key, at := range d.seen {
		if now.Sub(at) >= d.window {
			delete(d.seen, key)
		}
	}
}

// shareViewKey 把令牌与来源 IP 收敛成一个去重键。
//
// IP 先做哈希：这张表可能被 dump 出来排查问题，而「哪个 IP 在什么时候看了
// 哪张图」属于访问记录，不该以明文躺在调试输出里。令牌本身不哈希——它是
// 随机量，且已经被服务端当作主键查询过。
//
// IP 为空（未配置可信代理时的直连也可能拿不到）时退化为「按令牌去重」：
// 宁可少记，也不要把同一个人算成几十次。
func shareViewKey(token, ip string) string {
	if ip == "" {
		return token
	}
	sum := sha256.Sum256([]byte(ip))
	return token + "|" + hex.EncodeToString(sum[:8])
}
