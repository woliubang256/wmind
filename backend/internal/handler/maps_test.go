package handler

import (
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

func TestMapDeletedAtPreservesMilliseconds(t *testing.T) {
	deleted := time.Date(2026, 10, 24, 12, 0, 0, 500_000_000, time.FixedZone("UTC+8", 8*60*60))
	dto := toMapSummaryDTO(&domain.Map{DeletedAt: &deleted, UpdatedAt: deleted.Add(time.Hour)})
	if dto.DeletedAt == nil || *dto.DeletedAt != "2026-10-24T04:00:00.5Z" {
		t.Fatalf("deletion timestamp lost precision: %+v", dto.DeletedAt)
	}
}
