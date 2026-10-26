package service

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

var privateFileKey = regexp.MustCompile(`^file_(?:([1-9][0-9]*)_)?[a-f0-9]{32}\.(?:png|jpg|gif|webp)$`)
var publicAvatarKey = regexp.MustCompile(`^avatar_[0-9A-HJKMNP-TV-Z]{26}_[0-9A-HJKMNP-TV-Z]{26}\.png$`)

func PublicAvatarKey(key string) bool { return publicAvatarKey.MatchString(key) }

// PrivateFileOwner distinguishes legacy ownerless keys from new owned keys.
func PrivateFileOwner(key string) (owner int64, legacy, valid bool) {
	match := privateFileKey.FindStringSubmatch(key)
	if match == nil {
		return 0, false, false
	}
	if match[1] == "" {
		return 0, true, true
	}
	owner, err := strconv.ParseInt(match[1], 10, 64)
	return owner, false, err == nil
}

// Only canonical relative paths can grant a legacy reference. Absolute URLs,
// escaped separators and transient share credentials never create ownership.
func localAssetKey(src string) (string, bool) {
	if !strings.HasPrefix(src, "/uploads/") {
		return "", false
	}
	key := strings.TrimPrefix(src, "/uploads/")
	_, _, ok := PrivateFileOwner(key)
	return key, ok
}

func transformDocumentImages(raw []byte, visit func(string) (string, error)) ([]byte, error) {
	var doc map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	var topic func(any) error
	topic = func(value any) error {
		obj, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		if img, ok := obj["image"].(map[string]any); ok {
			if src, ok := img["src"].(string); ok {
				next, err := visit(src)
				if err != nil {
					return err
				}
				img["src"] = next
			}
		}
		if children, ok := obj["children"].(map[string]any); ok {
			for _, kind := range []string{"attached", "detached"} {
				items, _ := children[kind].([]any)
				for _, child := range items {
					if err := topic(child); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}
	sheets, _ := doc["sheets"].([]any)
	for _, value := range sheets {
		sheet, _ := value.(map[string]any)
		if err := topic(sheet["rootTopic"]); err != nil {
			return nil, err
		}
		floating, _ := sheet["floatingTopics"].([]any)
		for _, value := range floating {
			if err := topic(value); err != nil {
				return nil, err
			}
		}
	}
	return json.Marshal(doc)
}

func DocumentHasAsset(raw []byte, key string) bool {
	found := false
	_, err := transformDocumentImages(raw, func(src string) (string, error) {
		if candidate, ok := localAssetKey(src); ok && candidate == key {
			found = true
		}
		return src, nil
	})
	return err == nil && found
}

// ShareDocumentAssets only rewrites actual topic images, not notes, links or
// external URLs. The returned document is a response copy, never persisted.
func ShareDocumentAssets(raw []byte, token, access string) ([]byte, error) {
	return transformDocumentImages(raw, func(src string) (string, error) {
		if _, ok := localAssetKey(src); !ok {
			return src, nil
		}
		q := url.Values{"share": []string{token}}
		if access != "" {
			q.Set("access", access)
		}
		return src + "?" + q.Encode(), nil
	})
}

func (s *FileService) CanRead(ctx context.Context, ownerID int64, key string) (bool, error) {
	owner, legacy, valid := PrivateFileOwner(key)
	if !valid || ownerID <= 0 {
		return false, nil
	}
	if !legacy {
		return owner == ownerID, nil
	}
	references, err := s.legacyReferences(ctx, ownerID)
	return references[key], err
}

func (s *FileService) legacyReferences(ctx context.Context, ownerID int64) (map[string]bool, error) {
	refs := make(map[string]bool)
	add := func(src string) {
		if key, ok := localAssetKey(src); ok {
			refs[key] = true
		}
	}
	addDocument := func(raw []byte) {
		_, _ = transformDocumentImages(raw, func(src string) (string, error) { add(src); return src, nil })
	}
	if s.maps != nil {
		maps, err := s.maps.ListAllIncludingDeleted(ctx, ownerID)
		if err != nil {
			return nil, err
		}
		for _, m := range maps {
			add(m.ThumbnailURL)
			addDocument(m.Document)
		}
	}
	if s.templates != nil {
		templates, err := s.templates.ListByOwner(ctx, ownerID)
		if err != nil {
			return nil, err
		}
		for _, tpl := range templates {
			add(tpl.ThumbnailURL)
			full, err := s.templates.GetByUID(ctx, tpl.UID, ownerID)
			if err != nil {
				return nil, err
			}
			addDocument(full.Document)
		}
	}
	return refs, nil
}

func (s *FileService) ValidateURL(ctx context.Context, ownerID int64, src string) error {
	// Non-local image sources retain their existing behavior, but cannot grant
	// local ownership. Local query/fragment variants must never be persisted.
	if !strings.HasPrefix(src, "/uploads/") {
		return nil
	}
	if PublicAvatarKey(strings.TrimPrefix(src, "/uploads/")) {
		return s.validateExists(ctx, strings.TrimPrefix(src, "/uploads/"))
	}
	key, valid := localAssetKey(src)
	if valid {
		allowed, err := s.CanRead(ctx, ownerID, key)
		if err != nil {
			return apperr.Wrap(apperr.CodeInternalError, err)
		}
		if allowed {
			return s.validateExists(ctx, key)
		}
	}
	return apperr.New(apperr.CodeValidationFailed, "图片不属于当前账号").WithFieldErrors(map[string]string{"image": "请重新上传图片"})
}

// Production LocalStore supplies Exists; lightweight stores used without the
// collector keep their existing contract. The shared gate covers this check
// and the following database commit as one operation.
func (s *FileService) validateExists(ctx context.Context, key string) error {
	if store, ok := s.store.(interface {
		Exists(context.Context, string) (bool, error)
	}); ok {
		exists, err := store.Exists(ctx, key)
		if err != nil {
			return apperr.Wrap(apperr.CodeInternalError, err)
		}
		if !exists {
			return apperr.New(apperr.CodeValidationFailed, "图片已不存在，请重新上传").WithFieldErrors(map[string]string{"image": "图片已不存在，请重新上传"})
		}
	}
	return nil
}

func (s *FileService) ValidateDocument(ctx context.Context, ownerID int64, raw []byte) error {
	var legacy map[string]bool
	checked := make(map[string]bool)
	_, err := transformDocumentImages(raw, func(src string) (string, error) {
		if checked[src] {
			return src, nil
		}
		if key, ok := localAssetKey(src); ok {
			_, old, _ := PrivateFileOwner(key)
			if old {
				if legacy == nil {
					var err error
					legacy, err = s.legacyReferences(ctx, ownerID)
					if err != nil {
						return src, apperr.Wrap(apperr.CodeInternalError, err)
					}
				}
				if legacy[key] {
					checked[src] = true
					return src, s.validateExists(ctx, key)
				}
				return src, apperr.New(apperr.CodeValidationFailed, "图片不属于当前账号")
			}
		}
		checked[src] = true
		return src, s.ValidateURL(ctx, ownerID, src)
	})
	return err
}
