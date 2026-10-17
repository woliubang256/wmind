package domain

import "context"

// TxManager 开启一个事务，并把方言相关的事务句柄挂在传入的 ctx 上。
//
// 这是双方言方案里性价比最高的一处抽象：service 层写事务的代码在两种驱动下
// **逐字相同**，因为事务句柄的类型（pgx.Tx vs sql.Tx）被封在实现里。
//
// 代价是隐式依赖：仓储方法必须通过自己的 dbtx(ctx) 取句柄，不能直接用连接池，
// 否则会跑在事务之外——「保存了一半」这类 bug 极难发现。这条纪律由仓储层的
// 代码评审与集成测试守住。
//
// 用法：
//
//	err := s.tx.WithTx(ctx, func(ctx context.Context) error {
//	    m, err := s.maps.GetForUpdate(ctx, uid, ownerID)  // 自动跑在事务里
//	    if err != nil {
//	        return err
//	    }
//	    _, err = s.maps.UpdateWithVersion(ctx, in)
//	    return err
//	})
//
// fn 返回非 nil 错误即回滚；返回 nil 即提交。
type TxManager interface {
	WithTx(ctx context.Context, fn func(ctx context.Context) error) error
}

// txKey 是 ctx 中事务句柄的键类型。
//
// 用未导出的空结构体而不是字符串：避免不同包之间键名撞车，也避免外部
// 伪造一个键塞进 ctx 来绕过事务。
type txKey struct{}

// WithTxHandle 把事务句柄放进 ctx。仅供 repository 实现调用。
func WithTxHandle(ctx context.Context, handle any) context.Context {
	return context.WithValue(ctx, txKey{}, handle)
}

// TxHandle 取出 ctx 中的事务句柄；不在事务中时返回 nil, false。
func TxHandle(ctx context.Context) (any, bool) {
	handle := ctx.Value(txKey{})
	if handle == nil {
		return nil, false
	}
	return handle, true
}
