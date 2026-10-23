package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/woliubang256/wmind/backend/internal/backup"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

type BackupHandler struct{ manager *backup.Manager }

func NewBackupHandler(manager *backup.Manager) *BackupHandler {
	return &BackupHandler{manager: manager}
}
func backupJSON(c *gin.Context, target any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
	dec := json.NewDecoder(c.Request.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		response.Fail(c, apperr.New(apperr.CodeBadRequest, ""))
		return false
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		response.Fail(c, apperr.New(apperr.CodeBadRequest, ""))
		return false
	}
	return true
}
func backupFailure(c *gin.Context, err error, fallback apperr.Code) {
	switch {
	case errors.Is(err, backup.ErrBusy):
		response.Fail(c, apperr.New(apperr.CodeBackupBusy, ""))
	case errors.Is(err, backup.ErrStage):
		response.Fail(c, apperr.New(apperr.CodeBackupStageInvalid, ""))
	default:
		response.Fail(c, apperr.New(fallback, ""))
	}
}
func (h *BackupHandler) Get(c *gin.Context) { response.OK(c, h.manager.State()) }
func (h *BackupHandler) Save(c *gin.Context) {
	var input backup.Configuration
	if !backupJSON(c, &input) {
		return
	}
	if err := h.manager.Save(c.Request.Context(), input, middleware.UserDBID(c)); err != nil {
		backupFailure(c, err, apperr.CodeBackupConfigInvalid)
		return
	}
	response.OK(c, h.manager.State())
}
func (h *BackupHandler) Test(c *gin.Context) {
	var input backup.Configuration
	if !backupJSON(c, &input) {
		return
	}
	if err := h.manager.Test(c.Request.Context(), input); err != nil {
		backupFailure(c, err, apperr.CodeBackupRemoteFailed)
		return
	}
	response.OK(c, gin.H{"success": true})
}
func (h *BackupHandler) Run(c *gin.Context) {
	job, err := h.manager.StartBackup("manual")
	if err != nil {
		backupFailure(c, err, apperr.CodeBackupConfigInvalid)
		return
	}
	response.Created(c, job)
}
func (h *BackupHandler) Schedule(c *gin.Context) {
	var input struct {
		Cron     string `json:"cron"`
		Timezone string `json:"timezone"`
	}
	if !backupJSON(c, &input) {
		return
	}
	next, err := backup.Schedule(input.Cron, input.Timezone, time.Now())
	if err != nil {
		backupFailure(c, err, apperr.CodeBackupConfigInvalid)
		return
	}
	response.OK(c, gin.H{"nextRuns": next})
}
func (h *BackupHandler) Preview(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, backup.MaxZIPBytes+1)
	preview, err := h.manager.Inspect(c.Request.Context(), middleware.UserID(c), c.Request.Body)
	if err != nil {
		backupFailure(c, err, apperr.CodeBackupArchiveInvalid)
		return
	}
	response.OK(c, preview)
}
func (h *BackupHandler) Restore(c *gin.Context) {
	var input struct {
		ID      string `json:"id"`
		Confirm bool   `json:"confirm"`
	}
	if !backupJSON(c, &input) {
		return
	}
	if !input.Confirm {
		response.Fail(c, apperr.New(apperr.CodeBadRequest, "请确认覆盖恢复"))
		return
	}
	job, err := h.manager.StartRestore(middleware.UserID(c), input.ID)
	if err != nil {
		backupFailure(c, err, apperr.CodeBackupStageInvalid)
		return
	}
	response.Created(c, job)
}
