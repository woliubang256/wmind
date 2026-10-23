package middleware

import (
	"github.com/gin-gonic/gin"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"strings"
)

type MaintenanceGate interface{ Enter() (func(), bool) }

func Maintenance(gate MaintenanceGate) gin.HandlerFunc {
	return func(c *gin.Context) {
		p := c.Request.URL.Path
		// Control handlers serialize mutations themselves and expose cached progress.
		if gate == nil || p == "/api/v1/health/live" || p == "/api/v1/admin/backups" || strings.HasPrefix(p, "/api/v1/admin/backups/") {
			c.Next()
			return
		}
		leave, ok := gate.Enter()
		if !ok {
			c.Header("Retry-After", "10")
			response.Abort(c, apperr.New(apperr.CodeServiceUnavailable, "正在执行备份或恢复，请稍后重试"))
			return
		}
		defer leave()
		c.Next()
	}
}
