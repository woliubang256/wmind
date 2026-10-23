// Package settings 持有站点设置的内存快照。
//
// 设置的「键 → 类型 → 默认值 → 校验规则」全部集中在 schema.go 里，它是唯一
// 事实来源：新增一个设置项只改这里，仓储、handler 与两套迁移都不用动
// （值统一存成一段 JSON 文本，见 domain.Setting 的注释）。
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Kind 是设置项的值类型。
type Kind int

// 支持的类型。只保留这三种：设置项要么是开关、要么是数字、要么是一段文本。
const (
	KindString Kind = iota
	KindBool
	KindInt
)

// Spec 描述一个设置项。
type Spec struct {
	Key  string
	Kind Kind
	// Default 是默认值，用 JSON 文本表示，与库里的存储形式一致——
	// 这样「默认值」与「库里的值」走同一条解析路径。
	Default string
	// Public 表示未登录也能通过 GET /site/config 读到。
	Public bool
	// MinRunes / MaxRunes 仅对 KindString 生效（按字符数而非字节数，
	// 否则中文名会被按字节截断）。
	MinRunes int
	MaxRunes int
	// Min / Max 仅对 KindInt 生效。Max 为 0 表示不限。
	Min int64
	Max int64
	// Enum 非空时，KindString 的取值必须落在其中。
	Enum []string
}

// specs 是全部设置项，顺序即后台表单的分组顺序。
//
// 与 docs/03 §4.1 一一对应；改这里必须同步文档与前端表单。
var specs = []Spec{
	{Key: "site.name", Kind: KindString, Default: `"wmind"`, Public: true, MinRunes: 1, MaxRunes: 64},
	// 导出图片右下角的落款。默认空串 = 「跟站点名称走」，由 Snapshot.BrandName
	// 兜底——自建站的人改了站点名却忘了改这一项时，导出图上印的还是 wmind。
	{Key: "site.brand", Kind: KindString, Default: `""`, Public: true, MaxRunes: 64},
	{Key: "site.logo", Kind: KindString, Default: `""`, Public: true, MaxRunes: 512},
	{Key: "site.description", Kind: KindString, Default: `""`, Public: true, MaxRunes: 512},
	{Key: "site.icp", Kind: KindString, Default: `""`, Public: true, MaxRunes: 64},
	{Key: "site.base_url", Kind: KindString, Default: `""`, MaxRunes: 512},

	{Key: "auth.registration_enabled", Kind: KindBool, Default: `true`, Public: true},
	{Key: "auth.default_role", Kind: KindString, Default: `"user"`, Enum: []string{"user", "admin"}},
	{Key: "auth.password_min_length", Kind: KindInt, Default: `8`, Public: true, Min: 8, Max: 128},
	{Key: "auth.login_max_attempts", Kind: KindInt, Default: `5`, Min: 1, Max: 100},
	{Key: "auth.login_lock_minutes", Kind: KindInt, Default: `15`, Min: 1, Max: 1440},

	{Key: "limit.maps_per_user", Kind: KindInt, Default: `0`, Min: 0, Max: 1000000},
	{Key: "limit.upload_max_mb", Kind: KindInt, Default: `10`, Min: 1, Max: 1024},

	{Key: "feature.import_enabled", Kind: KindBool, Default: `true`, Public: true},
	{Key: "feature.export_enabled", Kind: KindBool, Default: `true`, Public: true},
	{Key: "feature.user_template_enabled", Kind: KindBool, Default: `true`, Public: true},

	{Key: "share.public_link_enabled", Kind: KindBool, Default: `true`, Public: true},
	{Key: "share.default_expire_days", Kind: KindInt, Default: `0`, Min: 0, Max: 3650},
	{Key: "share.default_allow_download", Kind: KindBool, Default: `true`},
	{Key: "share.require_password", Kind: KindBool, Default: `false`},
	{Key: "share.max_links_per_map", Kind: KindInt, Default: `20`, Min: 1, Max: 1000},
}

// byKey 是 specs 的索引，启动时构建一次。
var byKey = func() map[string]Spec {
	m := make(map[string]Spec, len(specs))
	for _, spec := range specs {
		m[spec.Key] = spec
	}
	return m
}()

// Specs 返回全部设置项的副本（按注册顺序）。
func Specs() []Spec {
	out := make([]Spec, len(specs))
	copy(out, specs)
	return out
}

// Lookup 按 key 查设置项。
func Lookup(key string) (Spec, bool) {
	spec, ok := byKey[key]
	return spec, ok
}

// KnownKeys 返回全部合法 key，用于「未知 key」错误的提示。
func KnownKeys() []string {
	out := make([]string, 0, len(specs))
	for _, spec := range specs {
		out = append(out, spec.Key)
	}
	sort.Strings(out)
	return out
}

// parse 把库里的 JSON 文本或请求体里的值解析成设置项要求的 Go 类型。
//
// raw 是「已经从 JSON 解码出来的 any」：库里读出来是 json.RawMessage，
// 请求体里是 bool / json.Number / string。两种来源共用这一处类型收敛，
// 避免「库里能存、接口不能存」这类不一致。
func (spec Spec) parse(raw any) (any, error) {
	switch spec.Kind {
	case KindBool:
		value, ok := raw.(bool)
		if !ok {
			return nil, errors.New("应为布尔值（true / false）")
		}
		return value, nil
	case KindInt:
		value, err := toInt64(raw)
		if err != nil {
			return nil, errors.New("应为整数")
		}
		if value < spec.Min || (spec.Max > 0 && value > spec.Max) {
			return nil, fmt.Errorf("应在 %d..%d 之间", spec.Min, spec.Max)
		}
		return value, nil
	case KindString:
		value, ok := raw.(string)
		if !ok {
			return nil, errors.New("应为字符串")
		}
		runes := len([]rune(value))
		if runes < spec.MinRunes || (spec.MaxRunes > 0 && runes > spec.MaxRunes) {
			return nil, fmt.Errorf("长度应在 %d..%d 个字符之间", spec.MinRunes, spec.MaxRunes)
		}
		if len(spec.Enum) > 0 {
			valid := false
			for _, candidate := range spec.Enum {
				if value == candidate {
					valid = true
					break
				}
			}
			if !valid {
				return nil, fmt.Errorf("只能是 %s", strings.Join(spec.Enum, " / "))
			}
		}
		return value, nil
	default:
		return nil, errors.New("类型未知")
	}
}

// parseStored 解析库里存的一段 JSON 文本。
func (spec Spec) parseStored(stored string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(stored))
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("存储值不是合法 JSON: %w", err)
	}
	return spec.parse(raw)
}

// encode 把已经通过校验的值编码成存储形式。
func (spec Spec) encode(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("编码 %s: %w", spec.Key, err)
	}
	return string(raw), nil
}

// defaultValue 返回解析后的默认值。specs 里写错了会在加载时立刻暴露。
func (spec Spec) defaultValue() (any, error) {
	return spec.parseStored(spec.Default)
}

// toInt64 把各种数字表示收敛成 int64。
//
// 请求体走 json.Number（UseNumber），库里也可能读到 json.Number；测试与
// 内部调用可能直接给 int。统一在这里处理，调用点不必关心来源。
func toInt64(raw any) (int64, error) {
	switch v := raw.(type) {
	case json.Number:
		return v.Int64()
	case int:
		return int64(v), nil
	case int32:
		return int64(v), nil
	case int64:
		return v, nil
	case float64:
		// 只有整值才接受：1.5 是「类型不对」，不该被静默截断成 1。
		if v != float64(int64(v)) {
			return 0, fmt.Errorf("不是整数")
		}
		return int64(v), nil
	default:
		return 0, fmt.Errorf("不是数字")
	}
}
