package settings

import (
	"sort"
	"time"
)

// Snapshot 是一份不可变的全量设置快照。
//
// 不可变是关键：读路径无锁（Service 用 atomic.Value 换指针），并发读者拿到
// 的一定是同一个自洽的版本，不会出现「读到一半被改掉」的撕裂读。
type Snapshot struct {
	values   map[string]any
	loadedAt time.Time
}

// LoadedAt 返回快照的加载时间，用于 TTL 兜底判断。
func (s *Snapshot) LoadedAt() time.Time { return s.loadedAt }

// String 读一个字符串设置项。键不存在时返回空串。
func (s *Snapshot) String(key string) string {
	value, _ := s.values[key].(string)
	return value
}

// Bool 读一个布尔设置项。键不存在时返回 false。
func (s *Snapshot) Bool(key string) bool {
	value, _ := s.values[key].(bool)
	return value
}

// Int 读一个整数设置项。键不存在时返回 0。
func (s *Snapshot) Int(key string) int {
	value, _ := s.values[key].(int64)
	return int(value)
}

// 语义化访问器。调用方用这些而不是裸 key，拼错 key 时是编译错误而不是
// 静默读到零值。

// SiteName 返回站点名称。
func (s *Snapshot) SiteName() string { return s.String("site.name") }

// RegistrationEnabled 报告是否开放注册。
func (s *Snapshot) RegistrationEnabled() bool { return s.Bool("auth.registration_enabled") }

// PasswordMinLength 返回密码最小长度。
func (s *Snapshot) PasswordMinLength() int {
	if n := s.Int("auth.password_min_length"); n > 0 {
		return n
	}
	return 8
}

// UploadMaxMB 返回单文件上传上限（MB）。
func (s *Snapshot) UploadMaxMB() int {
	if n := s.Int("limit.upload_max_mb"); n > 0 {
		return n
	}
	return 10
}

// MapsPerUser 返回每个用户的导图数量上限；0 表示不限制。
//
// 默认值就是 0（schema 里的 Default 与 Min 都是 0），语义是「不限」而不是
// 「一个都不许建」——把 0 当成上限会让新装的站点直接不能建导图。
func (s *Snapshot) MapsPerUser() int {
	return s.Int("limit.maps_per_user")
}

// DefaultRole 返回新用户默认角色。
func (s *Snapshot) DefaultRole() string {
	if role := s.String("auth.default_role"); role != "" {
		return role
	}
	return "user"
}

// All 返回全量设置（管理员接口用），键按字典序。
func (s *Snapshot) All() map[string]any {
	out := make(map[string]any, len(s.values))
	for key, value := range s.values {
		out[key] = value
	}
	return out
}

// Public 返回公开设置（未登录的 /site/config 用）。
//
// 只挑 Public 标记的键：敏感项（锁定阈值、上传上限）不能因为「反正前端
// 用不到」就留在同一个响应里，那等于把内部策略印在登录页上。
func (s *Snapshot) Public() map[string]any {
	out := make(map[string]any, len(specs))
	for _, spec := range specs {
		if !spec.Public {
			continue
		}
		if value, ok := s.values[spec.Key]; ok {
			out[spec.Key] = value
		}
	}
	return out
}

// Keys 返回快照里全部键（按字典序），用于日志与调试。
func (s *Snapshot) Keys() []string {
	out := make([]string, 0, len(s.values))
	for key := range s.values {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// defaultSnapshot 用 schema 里的默认值构造快照。
//
// 只在「首次启动、表里还没有任何记录」与「加载失败」两种情况下使用：
// 站点不能因为读不到设置就起不来。
func defaultSnapshot(loadedAt time.Time) (*Snapshot, error) {
	values := make(map[string]any, len(specs))
	for _, spec := range specs {
		value, err := spec.defaultValue()
		if err != nil {
			return nil, err
		}
		values[spec.Key] = value
	}
	return &Snapshot{values: values, loadedAt: loadedAt}, nil
}
