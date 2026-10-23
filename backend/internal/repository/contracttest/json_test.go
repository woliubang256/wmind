package contracttest

import "testing"

func TestSameJSONPreservesDocumentSemantics(t *testing.T) {
	for _, tc := range []struct {
		name, got, want string
		equal           bool
	}{
		{"key order and whitespace", `{"sheets": [], "formatVersion": 1}`, `{"formatVersion":1,"sheets":[]}`, true},
		{"equivalent number formatting", `{"value":1e2,"decimal":0.1250}`, `{"decimal":0.125,"value":100}`, true},
		{"large integer formatting", `{"value":9007199254740993.0}`, `{"value":9007199254740993}`, true},
		{"adjacent large integers", `{"value":9007199254740992}`, `{"value":9007199254740993}`, false},
		{"precise decimals", `{"value":0.12345678901234567890123}`, `{"value":0.12345678901234567890124}`, false},
		{"array order", `[1,2]`, `[2,1]`, false},
		{"nested values", `{"a":[null,true,{"value":9007199254740993}]}`, `{"a":[null,true,{"value":9007199254740992}]}`, false},
		{"null is not an array", `{"sheets":null}`, `{"sheets":[]}`, false},
		{"missing field", `{}`, `{"sheets":null}`, false},
		{"number is not a string", `{"value":1}`, `{"value":"1"}`, false},
		{"boolean difference", `{"done":true}`, `{"done":false}`, false},
		{"escaped unicode", `{"title":"\u5b63\u5ea6"}`, `{"title":"季度"}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := sameJSON(t, tc.got, tc.want); got != tc.equal {
				t.Fatalf("sameJSON(%s, %s) = %v, want %v", tc.got, tc.want, got, tc.equal)
			}
		})
	}
}
