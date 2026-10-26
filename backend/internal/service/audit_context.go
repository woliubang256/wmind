package service

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

func auditUserName(user *domain.User) string {
	if name := strings.TrimSpace(user.Nickname); name != "" {
		return name
	}
	return user.Username
}

func auditActor(user *domain.User) *domain.AuditActor {
	return &domain.AuditActor{UID: user.UID, Username: user.Username, Nickname: user.Nickname}
}

// auditEventDetail is an allowlist, never a serialization of a request/configuration.
func (s *AdminService) auditEventDetail(ctx context.Context, entry AuditEntry) map[string]any {
	fields := map[string][]string{
		domain.AuditUserCreate:  {"username", "email", "role"},
		domain.AuditUserUpdate:  {"email", "nickname"},
		domain.AuditUserDisable: {"from", "to"}, domain.AuditUserEnable: {"from", "to"},
		domain.AuditUserRoleChange:    {"from", "to"},
		domain.AuditUserDelete:        {"username", "email"},
		domain.AuditUserPasswordReset: {"generated", "username"},
		domain.AuditSettingsUpdate:    {"keys"},
		domain.AuditShareCreate:       {"mapUid", "mapTitle", "hasPassword", "allowDownload", "showNotes", "expiresAt"},
		domain.AuditShareRevoke:       {"mapUid", "mapTitle", "hasPassword", "allowDownload", "showNotes", "expiresAt"},
	}
	detail := make(map[string]any)
	for _, key := range fields[entry.Action] {
		if value, ok := entry.Detail[key]; ok {
			detail[key] = value
		}
	}
	if entry.Actor.ID != nil {
		if user, err := s.users.GetByID(ctx, *entry.Actor.ID); err == nil && user != nil {
			detail["actor"] = auditActor(user)
		}
	}
	if name := strings.TrimSpace(entry.TargetName); name != "" {
		detail["targetName"] = name
	}
	return detail
}

func auditString(detail map[string]json.RawMessage, key string) string {
	var value string
	_ = json.Unmarshal(detail[key], &value)
	return strings.TrimSpace(value)
}

// withAuditContext enriches copies only. Historical rows remain append-only.
// Per-page caches bound lookups and avoid repeatedly loading the same actor/target.
func (s *AdminService) withAuditContext(ctx context.Context, entries []*domain.AuditLog) []*domain.AuditLog {
	usersByID := make(map[int64]*domain.User)
	usersByUID := make(map[string]*domain.User)
	targetNames := make(map[string]string)
	result := make([]*domain.AuditLog, 0, len(entries))
	for _, entry := range entries {
		copy := *entry
		detail := make(map[string]json.RawMessage)
		_ = json.Unmarshal([]byte(entry.Detail), &detail)
		var actor domain.AuditActor
		if json.Unmarshal(detail["actor"], &actor) == nil && (actor.Username != "" || actor.UID != "") {
			copy.Actor = &actor
		} else if entry.ActorID != nil {
			user, loaded := usersByID[*entry.ActorID]
			if !loaded {
				user, _ = s.users.GetByID(ctx, *entry.ActorID)
				usersByID[*entry.ActorID] = user
			}
			if user != nil {
				copy.Actor = auditActor(user)
			}
		}
		copy.TargetName = auditString(detail, "targetName")
		if copy.TargetName == "" && entry.TargetType == "user" {
			copy.TargetName = auditString(detail, "nickname")
			if copy.TargetName == "" {
				copy.TargetName = auditString(detail, "username")
			}
			if copy.TargetName == "" && entry.TargetID != "" {
				user, loaded := usersByUID[entry.TargetID]
				if !loaded {
					user, _ = s.users.GetByUID(ctx, entry.TargetID)
					usersByUID[entry.TargetID] = user
				}
				if user != nil {
					copy.TargetName = auditUserName(user)
				}
			}
		}
		if copy.TargetName == "" && entry.TargetType == "share" {
			copy.TargetName = auditString(detail, "mapTitle")
			if copy.TargetName == "" && entry.ActorID != nil {
				mapUID := auditString(detail, "mapUid")
				// Both repositories require owner_id; legacy IDs never bypass that boundary.
				key := entry.TargetID
				if mapUID != "" {
					key = "map:" + mapUID
				}
				// Include actor ID: foreign legacy map UIDs must never reuse another owner's result.
				key = key + ":" + strconv.FormatInt(*entry.ActorID, 10)
				name, loaded := targetNames[key]
				if !loaded {
					if mapUID != "" && s.maps != nil {
						if item, err := s.maps.GetByUID(ctx, mapUID, *entry.ActorID); err == nil && item != nil {
							name = item.Title
						}
					} else if entry.TargetID != "" && s.shares != nil {
						if item, err := s.shares.GetByUID(ctx, entry.TargetID, *entry.ActorID); err == nil && item != nil {
							name = item.MapTitle
						}
					}
					targetNames[key] = name
				}
				copy.TargetName = name
			}
		}
		result = append(result, &copy)
	}
	return result
}
