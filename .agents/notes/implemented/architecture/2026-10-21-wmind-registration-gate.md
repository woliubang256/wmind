# Agent Note: 关闭注册的闸门要排在限流器前面

Status: implemented

## Problem

M1 验收标准 1 写的是「关闭注册后，注册页不可达，直接调接口返回 403
`REGISTRATION_CLOSED`」。当时**只调用了一次**，所以通过了。

复核时发现三件事只有连着做才会露出来：

```
g.POST("/register", limiters.register.Middleware(...), deps.Auth.Register)
                     ↑ 先扣配额                    ↑ 再判关站
```

1. **关站之后每个注册请求都注定失败，但它照样扣一次配额**（3 次/小时/IP）。
   用户在登录页点几下、或者脚本重试几次，就把这个 IP 一小时的注册配额烧光。
2. 配额烧光后返回的是 **429 `RATE_LIMITED`**，不是 403 `REGISTRATION_CLOSED`。
   客户端看到「请求过于频繁」，会以为「等一会儿就能注册」——等一小时也不行。
3. 管理员重新开站之后，刚才点过的 IP 仍然被 429 挡着。**「关站」把一个一小时后
   才该发生的错误提前制造了出来**，而且和关站本身没有因果关系。

前端那半边是对的：登录页在 `registrationEnabled === false` 时不渲染入口，
`/register` 显示「暂未开放注册」。所以这个 bug 只从接口侧可见。

## Decision

### 闸门前置成中间件

`middleware.RequireRegistrationOpen(open func() bool)` 挂在限流器**之前**：

```go
g.POST("/register",
    middleware.RequireRegistrationOpen(deps.RegistrationOpen),
    limiters.register.Middleware(middleware.ClientIPKey),
    deps.Auth.Register)
```

`open` 为 nil 时视为开放——装配期漏传不该把注册功能悄悄关掉。

服务层 `AuthService.Register` 里那道 `s.site.RegistrationEnabled()` **保留**。
两层不是冗余：中间件是「不让注定失败的请求进入后续链路」，服务层是「这个业务
规则本身的守卫」。将来若从别处（CLI、后台建号）调用 `Register`，服务层那道仍然
在；而中间件那层拿不到 handler 内部的服务实例，所以 `Deps` 里单独给一个函数：

```go
RegistrationOpen func() bool   // main.go: settingsSvc.RegistrationEnabled
```

### 前端两处收紧

1. `useSiteConfig({ fresh: true })`：登录页与注册页每次挂载都重新拉一次配置。
   默认的 5 分钟 `staleTime` 是为站名这类东西设的，而这两个页面的配置直接决定
   「入口在不在」——管理员刚关掉注册，用户不该还能看到「立即注册」并点进去填表。
   代价是一次几百字节的 GET，只在真正落到这两页时发生。
2. 登录页在配置还没回来时**不渲染那一块**。兜底值是 `registrationEnabled: false`，
   直接渲染会让开放注册的站点先闪一句「本站暂未开放注册」再变成「立即注册」——
   正好把最关键的信息说反一次。

## Consequences

- 关站期间的探测不消耗配额，重开站后第一次注册就能成。
- 客户端拿到的永远是 `REGISTRATION_CLOSED`（403），而不是有时 429 有时 403。
- `httpapi.Deps` 多一个字段。所有装配点（`cmd/server`、`httpapi` 的测试服务器）
  都要传；漏传等于「视为开放」，与本次修复前的行为一致，不会静默关掉注册。
- 后端 `TestRegisterClosedOverHTTP`：关站后连打 5 次断言全是 403
  `REGISTRATION_CLOSED`，再开站断言第一次注册 201。**把闸门挪到限流器后面这条
  测试立刻变红**（第 4 次拿到 429），已经反向验证过。这是「配额没被吃掉」的
  确定性证明——进程内新建限流器，不受外部状态影响。
- 前端 `e2e/register.mjs` 11 条：入口消失、`/register` 拿不到表单、接口 403、
  连打 5 次不退化、重开即恢复、重开后不再返回 `REGISTRATION_CLOSED`。
  最后一条**刻意不断言 201**：e2e 的注册配额（3 次/小时/IP）是几套脚本共用的
  全局状态，前面几套各建一个号就用完了，此时重开后拿到 429 是正确的限流，不是
  闸门问题。把 201 断言放进 e2e 只会得到一条随执行顺序变红的用例。
- 脚本会改站点设置，所以 `finally` 里无条件恢复成开放：它被别的套件跟在后面跑，
  留一个「已关站」的实例会让别人的注册全部失败。

## Alternatives considered

- **只在服务层加一道「不扣配额」的特判**：限流器是路由层的中间件，服务层够不到
  它。要么把限流器下沉到服务层（把 HTTP 关注点漏进业务层），要么就在这里加闸门。
- **关站时干脆不注册 `/auth/register` 路由**：返回 404。但设置可以在运行时改，
  路由表是启动时定的——要么重启才生效，要么动态改路由表（gin 不支持，要重建
  引擎并处理并发）。而且 404 会让客户端以为「接口没了」，不如 403 明确。
- **让限流器「事后回滚」配额**：需要在 handler 返回后判断错误码再退还令牌，
  等于给令牌桶加一个反向操作，并发下很难正确，而且回滚本身也会被绕过。
- **前端把注册入口做成「点了才知道」**（不做配置判断）：入口永远在，点了才 403。
  比现在差：用户填完表单才被告知不能注册，白填一次。
