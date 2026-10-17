package middleware

import (
	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/pkg/reqid"
)

// gin.Context 中使用的键。集中定义，避免字符串在各处拼写漂移。
const (
	ctxKeyRequestID = "wmind.requestID"
	ctxKeyUserID    = "wmind.userID"   // M1 的 RequireAuth 写入
	ctxKeyUserDBID  = "wmind.userDBID" // M1 的 RequireAuth 写入
	ctxKeyUserRole  = "wmind.userRole" // M1 的 RequireAuth 写入
)

// RequestIDFrom 返回当前请求的 ID。
//
// 命名为 From 而不是直接叫 RequestID，是为了与同包的 RequestID 中间件
// 区分开——两者一个是取值器、一个是中间件构造器。
func RequestIDFrom(c *gin.Context) string {
	return reqid.FromContext(c.Request.Context())
}

// UserID 返回已认证用户的 uid；未认证时返回空串。
//
// 由 M1 的 RequireAuth 中间件写入。这里先定义访问器，让访问日志与后续
// handler 有统一入口，不必各自去 c.Get 猜键名。
func UserID(c *gin.Context) string {
	return stringFromContext(c, ctxKeyUserID)
}

// UserRole 返回已认证用户的角色；未认证时返回空串。
func UserRole(c *gin.Context) string {
	return stringFromContext(c, ctxKeyUserRole)
}

// UserDBID 返回已认证用户的自增主键；未认证时返回 nil。
//
// 业务接口一律用 uid（对外的稳定标识），但审计日志与 settings.updated_by
// 存的是主键——它们是内部表，用 int64 外键比字符串省空间也省索引。
func UserDBID(c *gin.Context) *int64 {
	v, ok := c.Get(ctxKeyUserDBID)
	if !ok {
		return nil
	}
	id, ok := v.(int64)
	if !ok {
		return nil
	}
	return &id
}

func stringFromContext(c *gin.Context, key string) string {
	if v, ok := c.Get(key); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
