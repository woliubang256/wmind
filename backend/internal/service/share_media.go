package service

import "context"

// AuthorizeAsset rechecks the current share and password revision without
// counting an image fetch as another visit or exposing hidden document fields.
func (s *ShareService) AuthorizeAsset(ctx context.Context, token, access, key string) bool {
	if _, _, valid := PrivateFileOwner(key); !valid {
		return false
	}
	payload, err := s.readPublic(ctx, token, access, "", false)
	return err == nil && DocumentHasAsset(payload.Document, key)
}
