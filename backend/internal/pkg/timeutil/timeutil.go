// Package timeutil 统一两种方言的时间序列化格式。
//
// 为什么需要它：SQLite 没有原生时间类型，时间列是 TEXT。要让「字符串比较」
// 等价于「时间比较」，格式必须满足三个条件——UTC、定长、带 Z 后缀。
// 少了任何一个，跨时区或跨精度比较都会**静默出错**（不会报错，只会返回错的行）。
//
// PostgreSQL 侧用 TIMESTAMPTZ，不需要本包；本包只服务 SQLite 实现。
// 但格式常量放在这里而不是 sqlite 包内，是为了让契约测试能断言「两种方言写出的
// 时间字符串格式一致」。
package timeutil

import "time"

// Layout 是 SQLite 时间列的存储格式，与迁移文件里的
// strftime('%Y-%m-%dT%H:%M:%fZ','now') 严格对应：
//
//	%Y-%m-%d   → 2006-01-02
//	T          → T
//	%H:%M:%f   → 15:04:05.000
//	Z          → Z（字面量，表示 UTC）
const Layout = "2006-01-02T15:04:05.000Z"

// Format 把时间序列化为存储格式。
//
// 先转 UTC 再格式化：传进来的时间可能带任意时区（如 time.Local），
// 不归一化就会写出「带 Z 后缀但其实是本地时间」的假 UTC，那是最糟的情况——
// 格式看着对，比较结果全错。
func Format(t time.Time) string {
	return t.UTC().Format(Layout)
}

// FormatPtr 处理可空时间列，nil 映射为 SQL NULL。
func FormatPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return Format(*t)
}

// Parse 解析存储格式。字符串无时区信息，解析结果落在 UTC。
func Parse(s string) (time.Time, error) {
	return time.Parse(Layout, s)
}

// ParsePtr 解析可空时间列；空串视为 NULL。
func ParsePtr(s string) (*time.Time, error) {
	if s == "" {
		return nil, nil
	}
	t, err := Parse(s)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// Now 返回当前时间。
//
// 存在的意义是给测试留一个替换点，也提醒调用方「时间由 Go 计算」这条纪律
// 是主动设计而不是随手写 time.Now()。
func Now() time.Time {
	return time.Now()
}
