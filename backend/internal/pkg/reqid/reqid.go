// Package reqid 在 context 中携带请求 ID。
//
// 独立成包是为了打破一个循环：`response` 需要读请求 ID 来填充响应信封，
// `middleware` 需要写请求 ID 并调用 `response` 渲染错误。把键放在这里，
// 两边都只依赖本包。
package reqid

import "context"

type ctxKey struct{}

// WithContext 返回携带 requestID 的新 context。
func WithContext(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, ctxKey{}, requestID)
}

// FromContext 取出 requestID；不存在时返回空串。
func FromContext(ctx context.Context) string {
	requestID, _ := ctx.Value(ctxKey{}).(string)
	return requestID
}
