package service

import (
	"strings"
	"testing"
)

func TestShareAssetTraversalIncludesAllSheetsAndFoldedTopicsOnly(t *testing.T) {
	key := "file_7_0123456789abcdef0123456789abcdef.png"
	path := "/uploads/" + key
	raw := []byte(`{"format":"wmind","large":9007199254740993,"sheets":[{"rootTopic":{"collapsed":true,"children":{"attached":[{"image":{"src":"` + path + `"}}],"detached":[{"image":{"src":"https://other.invalid/image.png"}}]}}},{"floatingTopics":[{"image":{"src":"` + path + `"}}]}]}`)
	if !DocumentHasAsset(raw, key) {
		t.Fatal("folded and floating image not found")
	}
	got, err := ShareDocumentAssets(raw, "public-token", "access-proof")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(got), "access=access-proof") != 2 || !strings.Contains(string(got), "9007199254740993") || !strings.Contains(string(got), `"src":"https://other.invalid/image.png"`) {
		t.Fatalf("unexpected transformed document: %s", got)
	}
	for _, raw := range []string{
		`{"sheets":[{"rootTopic":{"notes":{"image":{"src":"` + path + `"}}}}]}`,
		`{"sheets":[{"rootTopic":{"extensions":[{"image":{"src":"` + path + `"}}]}}]}`,
		`{"sheets":[{"rootTopic":{"image":{"src":"https://wmind.invalid` + path + `"}}}]}`,
		`{"sheets":[{"rootTopic":{"image":{"src":"` + path + `?share=old"}}}]}`,
	} {
		if DocumentHasAsset([]byte(raw), key) {
			t.Errorf("non-image/canonical reference granted: %s", raw)
		}
	}
}

func TestMediaFileKeyBoundaries(t *testing.T) {
	for _, key := range []string{"file_0_0123456789abcdef0123456789abcdef.png", "file_9223372036854775808_0123456789abcdef0123456789abcdef.png", "file_1_abc.png", "file_1_0123456789abcdef0123456789abcdef.svg", "../file_0123456789abcdef0123456789abcdef.png"} {
		if _, _, ok := PrivateFileOwner(key); ok {
			t.Errorf("accepted unsafe key %q", key)
		}
	}
	if owner, legacy, ok := PrivateFileOwner("file_12_0123456789abcdef0123456789abcdef.png"); !ok || legacy || owner != 12 {
		t.Fatal("valid owned key rejected")
	}
	if _, legacy, ok := PrivateFileOwner("file_0123456789abcdef0123456789abcdef.png"); !ok || !legacy {
		t.Fatal("legacy key rejected")
	}
}
