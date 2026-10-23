package settings

import "testing"

// 品牌落款的回退规则：留空 = 跟站点名走。
//
// 这条不是「顺手兜个空」，而是后台表单上那句话的字面意思。改回退位置时
// （比如挪到写入侧、把默认值写成当前站点名）这条用例会红。
func TestBrandNameFallsBackToSiteName(t *testing.T) {
	cases := []struct {
		name   string
		values map[string]any
		want   string
	}{
		{
			name:   "留空回退到站点名",
			values: map[string]any{"site.name": "Acme 思维", "site.brand": ""},
			want:   "Acme 思维",
		},
		{
			name:   "只写空白也回退",
			values: map[string]any{"site.name": "Acme 思维", "site.brand": "   "},
			want:   "Acme 思维",
		},
		{
			name:   "显式设置优先",
			values: map[string]any{"site.name": "Acme 思维", "site.brand": "Acme Docs"},
			want:   "Acme Docs",
		},
		{
			name:   "显式设置去掉两端空白",
			values: map[string]any{"site.name": "Acme 思维", "site.brand": "  Acme  "},
			want:   "Acme",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := &Snapshot{values: tc.values}
			if got := snapshot.BrandName(); got != tc.want {
				t.Fatalf("BrandName() = %q，期望 %q", got, tc.want)
			}
		})
	}
}
