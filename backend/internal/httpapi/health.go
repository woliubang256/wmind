package httpapi

import (
	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

// registerHealth 注册健康检查接口。
func registerHealth(g *gin.RouterGroup, deps Deps) {
	h := g.Group("/health")

	// 存活探针：进程活着就 200，不检查任何依赖。
	//
	// 故意不查数据库——若查了，数据库抖动会让编排器反复重启一个本来健康的
	// 容器，把小故障放大成不可用。
	h.GET("/live", func(c *gin.Context) {
		response.OK(c, gin.H{"status": "ok"})
	})

	// 就绪探针：任一依赖不可用即 503，并把逐项结果放进 details.checks，
	// 让运维不必翻日志就知道是哪一项挂了。
	h.GET("/ready", func(c *gin.Context) {
		ctx := c.Request.Context()
		checks := make(map[string]string, len(deps.Ready))
		var failed []string

		for _, check := range deps.Ready {
			if err := check.Ping(ctx); err != nil {
				checks[check.Name] = "error"
				failed = append(failed, check.Name)
				deps.Logger.ErrorContext(ctx, "就绪检查失败", "check", check.Name, "err", err)
				continue
			}
			checks[check.Name] = "ok"
		}

		if len(failed) > 0 {
			response.Fail(c, apperr.New(apperr.CodeServiceUnavailable, "").
				WithDetail("checks", checks).
				WithDetail("failed", failed))
			return
		}
		response.OK(c, gin.H{"status": "ok", "checks": checks})
	})
}
