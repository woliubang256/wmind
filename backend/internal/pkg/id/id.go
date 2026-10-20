// Package id 生成对外标识符。
package id

import (
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/oklog/ulid/v2"
)

// New 生成一个新的 ULID 字符串。
//
// 用 ULID 而不是自增 ID 对外：自增 ID 会暴露系统规模与创建顺序，也不利于
// 将来分库。ULID 按时间字典序排列，天然可按创建时间排序，且与 UUIDv7 一样
// 是 128 位随机量。
func New() string {
	// crypto/rand 读取失败意味着进程环境已不可信（内核熵源异常），
	// 此时继续运行只会产出重复 ID，直接 panic 更诚实。
	return ulid.MustNew(ulid.Timestamp(time.Now()), rand.Reader).String()
}

// Valid 报告 s 是否为合法的 ULID。
//
// 用于校验外部传入的 ID：不合法的输入必须尽早拒绝，而不是让它进入数据库
// 或日志。
func Valid(s string) bool {
	_, err := ulid.ParseStrict(s)
	return err == nil
}

// Random 生成 128 位随机标识（小写十六进制，32 字符）。
//
// 与 New 的区别：ULID 的前 48 位是时间戳，同一毫秒内的取值可以按时间猜出来。
// 文件 URL 是**唯一**的访问凭证（不带鉴权），所以这里用纯随机量——「不可枚举」
// 必须由生成方式保证，而不是靠没人去猜。
func Random() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// 与 New 一致：熵源异常时继续运行只会产出重复标识。
		panic("id: 读取随机源失败: " + err.Error())
	}
	return hex.EncodeToString(buf)
}
