package service

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

type auditContextRepo struct {
	domain.AuditRepo
	entries []*domain.AuditLog
}

func (r *auditContextRepo) Create(_ context.Context, in domain.CreateAuditLogInput) error {
	r.entries = append(r.entries, &domain.AuditLog{ID: int64(len(r.entries) + 1), ActorID: in.ActorID, Action: in.Action, TargetType: in.TargetType, TargetID: in.TargetID, Detail: in.Detail, IP: in.IP, CreatedAt: in.Now})
	return nil
}
func (r *auditContextRepo) List(context.Context, domain.AuditFilter, domain.Page) ([]*domain.AuditLog, error) {
	return r.entries, nil
}
func (r *auditContextRepo) Count(context.Context, domain.AuditFilter) (int64, error) {
	return int64(len(r.entries)), nil
}

type auditContextUsers struct {
	domain.UserRepo
	byID              map[int64]*domain.User
	byUID             map[string]*domain.User
	idCalls, uidCalls int
}

func (r *auditContextUsers) GetByID(_ context.Context, id int64) (*domain.User, error) {
	r.idCalls++
	if u := r.byID[id]; u != nil {
		return u, nil
	}
	return nil, domain.ErrNotFound
}
func (r *auditContextUsers) GetByUID(_ context.Context, uid string) (*domain.User, error) {
	r.uidCalls++
	if u := r.byUID[uid]; u != nil {
		return u, nil
	}
	return nil, domain.ErrNotFound
}

type auditContextMaps struct {
	domain.MapRepo
	calls int
}

func (r *auditContextMaps) GetByUID(_ context.Context, uid string, ownerID int64) (*domain.Map, error) {
	r.calls++
	if uid == "legacy-map" && ownerID == 1 {
		return &domain.Map{UID: uid, Title: "现有导图名称"}, nil
	}
	return nil, domain.ErrNotFound
}

func TestAuditContextSnapshotSurvivesActorRemovalAndRejectsSensitiveFields(t *testing.T) {
	id := int64(1)
	users := &auditContextUsers{byID: map[int64]*domain.User{1: {ID: 1, UID: "actor", Username: "admin", Nickname: "事件时名称"}}}
	repo := &auditContextRepo{}
	s := &AdminService{users: users, audit: repo, now: time.Now, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	detail := map[string]any{"hasPassword": true, "allowDownload": false, "showNotes": true, "expiresAt": nil, "mapUid": "map", "mapTitle": "事件时导图", "password": "do-not-store", "apiKey": "do-not-store", "token": "do-not-store", "actor": map[string]any{"username": "spoofed"}}
	if err := s.Record(t.Context(), AuditEntry{Actor: Actor{ID: &id}, Action: domain.AuditShareCreate, TargetType: "share", TargetID: "share", TargetName: "事件时导图", Detail: detail}); err != nil {
		t.Fatal(err)
	}
	if _, ok := detail["targetName"]; ok {
		t.Fatal("Record mutated caller detail")
	}
	if strings.Contains(repo.entries[0].Detail, "do-not-store") || strings.Contains(repo.entries[0].Detail, "spoofed") {
		t.Fatalf("unsafe snapshot = %s", repo.entries[0].Detail)
	}
	delete(users.byID, 1)
	repo.entries[0].ActorID = nil // real FK ON DELETE SET NULL must not erase the event identity.
	logs, _, err := s.ListAuditLogs(t.Context(), AuditQuery{})
	if err != nil || logs[0].Actor == nil || logs[0].Actor.Nickname != "事件时名称" || logs[0].TargetName != "事件时导图" {
		t.Fatalf("event context = %#v, %v", logs, err)
	}
	if repo.entries[0].Actor != nil || repo.entries[0].TargetName != "" {
		t.Fatal("read rewrote historical entry")
	}
}

func TestAuditContextLegacyFallbackIsOwnerScopedCachedAndReadOnly(t *testing.T) {
	id, other := int64(1), int64(2)
	users := &auditContextUsers{byID: map[int64]*domain.User{1: {UID: "actor", Username: "admin"}}, byUID: map[string]*domain.User{"user": {UID: "user", Username: "target"}}}
	maps := &auditContextMaps{}
	repo := &auditContextRepo{entries: []*domain.AuditLog{
		{ActorID: &id, TargetType: "user", TargetID: "user", Detail: `{}`},
		{ActorID: &id, TargetType: "user", TargetID: "user", Detail: `{}`},
		{ActorID: &id, TargetType: "share", Detail: `{"mapUid":"legacy-map"}`},
		{ActorID: &id, TargetType: "share", Detail: `{"mapUid":"legacy-map"}`},
		{ActorID: &other, TargetType: "share", Detail: `{"mapUid":"legacy-map"}`},
		{TargetType: "user", TargetID: "missing", Detail: `not JSON`},
	}}
	s := &AdminService{users: users, maps: maps, audit: repo}
	logs, _, err := s.ListAuditLogs(t.Context(), AuditQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if logs[0].TargetName != "target" || logs[2].TargetName != "现有导图名称" || logs[4].TargetName != "" || logs[5].TargetName != "" || logs[5].Actor != nil {
		t.Fatalf("legacy context = %#v", logs)
	}
	if users.idCalls != 2 || users.uidCalls != 2 || maps.calls != 2 {
		t.Fatalf("queries = %d/%d/%d; expected per-page actor/target cache", users.idCalls, users.uidCalls, maps.calls)
	}
	if repo.entries[0].Actor != nil || repo.entries[2].Detail != `{"mapUid":"legacy-map"}` {
		t.Fatal("legacy read mutated stored log")
	}
}

func TestAuditSettingsDetailStoresOnlyChangedKeys(t *testing.T) {
	repo := &auditContextRepo{}
	s := &AdminService{audit: repo, now: time.Now, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := s.Record(t.Context(), AuditEntry{Action: domain.AuditSettingsUpdate, TargetType: "settings", Detail: map[string]any{"keys": []string{"ai.config"}, "apiKey": "secret", "values": map[string]any{"password": "secret"}}}); err != nil {
		t.Fatal(err)
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(repo.entries[0].Detail), &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail) != 1 || detail["keys"] == nil || strings.Contains(repo.entries[0].Detail, "secret") {
		t.Fatalf("settings detail = %s", repo.entries[0].Detail)
	}
}
