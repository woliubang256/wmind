# Agent Note: 用户自助：指针字段局部更新 + 头像按解码判定类型

Status: implemented

## Problem

M1-3 要实现「我的」页面的三个动作：改昵称/邮箱、改密码、换头像。docs/04 §5.2 只给了接口形状，没规定四件会影响实现形态的事：

- 局部更新怎么区分「字段没传」与「传了空串」——昵称允许清空，邮箱不允许。
- 改资料要不要事务：昵称与邮箱是两条 UPDATE。
- 「这个上传文件是不是图片」凭什么判定。
- 头像存成什么格式、文件名怎么起、旧文件什么时候删。

## Decision

### 局部更新用指针字段，不用 `omitempty` + 结构体零值

`ProfileUpdate{Nickname *string, Email *string}`：`nil` 表示「这次不动它」，非 nil 才参与比较与写入。

值类型做不到这个区分——`nickname: ""` 与「没传 nickname」在 `string` 上都是 `""`。用 `json.RawMessage` 或 map 再手工解析能work，但把类型信息丢掉了，校验只能写在 handler 里。指针是最小代价：handler 原样透传，判断集中在 service。

昵称允许清空（空串合法），邮箱不允许——邮箱是登录标识，清空等于把自己锁在门外，所以空串走格式校验并失败。

### 改资料包一个事务

「昵称改成功、邮箱撞了唯一索引」会留下只改一半的资料，而用户看到的是 409，会以为整次修改都没生效。所以先做完全部校验（含邮箱查重），再在 `TxManager.WithTx` 里写两条 UPDATE。

代价是「先查重再写」之间仍有窗口，并发时唯一索引会抛 `domain.ErrDuplicate`；`apply` 里把它翻译成 `AUTH_EMAIL_TAKEN`，所以两条路径的对外表现一致。

### 改密码放在 AuthService，不放在 UserService

改密码要撤销会话（保留当前设备、踢掉其它设备），而撤销逻辑、刷新令牌仓储、密码策略都在认证侧。放进 UserService 就得把这些依赖也搬过去，等于把认证策略拆成两半。

当前设备靠刷新令牌 Cookie 定位：服务端只能从这次请求知道哪一台是「当前设备」。为此 `RefreshCookieName` 提成 handler 包的常量，`NewUserHandler` 从调用方的 `CookieConfig` 收名字——两处各写一份默认值，改配置时必然漏掉一处。

### 头像：「是不是图片」只认解码结果

`image.Decode` 失败就是 `FILE_TYPE_NOT_ALLOWED`。Content-Type 与扩展名都由客户端提供，伪造成本为零；解码是唯一可信的判定，顺带也防了「改后缀的 HTML/JS」被当图片托管出去（存储型 XSS 的常见入口）。

输出统一 PNG：
- WebP 编码要 cgo 或第三方纯 Go 编码器，为了 256×256 的头像不值得引依赖；
- JPEG 没有 alpha 通道，透明头像会被压成黑底；
- PNG 解码器仍然注册了（`golang.org/x/image/webp` + stdlib jpeg/png），所以**输入**可以是 webp/jpeg/png，只是**输出**统一 PNG。

居中裁剪再 `CatmullRom` 缩放，不直接压扁：宽图压成正方形会让人脸变形，而头像几乎都是人脸。

### 落盘：临时文件 + rename，键用 ULID

- `Save` 先写 `.upload-*` 临时文件再 `os.Rename`。进程写到一半被杀，目录里不会留半张图片——半张图片比没有图片更难排查。
- 键是 `avatar_<uid>_<ulid>.png`。用时间戳会在同一毫秒内撞（测试里冻结时钟时 100% 撞），ULID 单调且不依赖时钟。
- 写库失败就删掉刚存的文件，避免磁盘里堆孤儿文件。
- 删旧头像只删**自己 URL 前缀下**的：`AvatarURL` 二期可能指向对象存储的绝对地址，那种值不该被当成键去删。

### 上传大小：`MaxBytesReader` 提前拦截，超限统一 `FILE_TOO_LARGE`

先解析再判大小等于让一个 1GB 的上传先落进临时文件，限制失去意义。所以 `MaxBytesReader(max+64KB)` 挂在 body 上——多给的 64KB 是 multipart boundary 与表单头的余量，正好卡在上限的文件加上框架字节也会超。

`MaxBytesReader` 超限返回 `*http.MaxBytesError`，不单独识别就会退化成「参数校验失败」，前端没法给出正确提示。`uploadError` 把它映射成 `FILE_TOO_LARGE` + `details.maxBytes`，落在余量里的文件由 service 的大小检查兜住，两条路径对外一致。

## Alternatives considered

- **`PATCH` 用 `map[string]any` 手工判断键存在** — 能区分「没传」，但把类型信息丢进 `any`，每个字段都要手写类型断言与错误分支。
- **拆成 `PATCH /users/me/nickname` 与 `PATCH /users/me/email` 两个接口** — 每个接口只有一个字段，不需要区分「没传」。被否是因为前端表单本来就是一次提交，拆开要么两次请求要么引入新的批量语义。
- **头像存原图，前端用 CSS 裁切** — 省掉 imageproc。被否是因为原图可能是 10MB 的 6000×4000，列表页几十个头像直接把流量打爆；而且原图里的 EXIF 会带上拍摄地点。
- **头像存 WebP** — 体积约为 PNG 的 1/3。被否是因为纯 Go 的 WebP 编码器要么质量差要么引入较重依赖，而 256×256 的 PNG 只有几十 KB。
- **头像文件名用 `uid.png` 固定覆盖** — 不用删旧文件。被否是因为浏览器与 CDN 会缓存同 URL，换头像后用户看到的还是旧图；带随机后缀才能靠 URL 变化破缓存。
- **`os.Create` 直接写目标文件** — 少一次 rename。被否是崩溃会留下截断的 PNG，而浏览器对截断 PNG 的表现是「显示一半」而不是「加载失败」，很难归因。

## Consequences

- **收益**：`PATCH /users/me` 一次请求改多个字段，语义清晰；邮箱冲突不会留下半改状态。
- **收益**：上传接口对「假图片」「超大文件」都给出准确错误码，前端可以分别提示。
- **收益**：头像输出规格固定（256×256 PNG），前端不用处理各种尺寸与格式。
- **代价**：头像处理是同步的。256×256 的 CatmullRom 缩放约 10ms 量级，单请求可接受；若将来要支持相册原图，必须改成异步任务。
- **代价**：`Storage.Dir` 在两处出现——`NewLocalStore` 用它建 store，`httpapi.NewRouter` 用它挂 `r.Static("/uploads", dir)`。两者不一致的症状是「上传成功但取不到文件」（M1-3 的 HTTP 测试正是踩到这个才补上）。`LocalStore.Dir()` 已经留好，后续应改为从 store 取目录。
- **已知上限**：头像目录是平铺的，十万用户就是十万个文件在同一个目录里。ext4/APFS 能扛，但 `ls` 会变慢；真要上规模应按 uid 哈希分两级子目录。

## Verification

- `go test ./internal/imageproc/...`：正方形输入不裁剪、宽图/高图居中裁剪、透明通道保留、非图片返回 `ErrUnsupportedImage`、输出尺寸固定。
- `go test ./internal/storage/...`：写入后可读、重复删除幂等、键含 `../` 或分隔符被拒、URL 拼接。
- `go test ./internal/service/...`：只传昵称时邮箱不变、传空昵称清空、邮箱冲突返回 `AUTH_EMAIL_TAKEN`、头像写库失败时回滚文件、二次上传删除旧文件。
- `go test ./internal/httpapi/...`：改资料 200/422（字段级错误）/409、未登录 401；改密旧密码错 401、弱密码 422、成功后新密码可登录且旧密码不可；头像上传 200 且静态路由可取回 256×256 PNG、二次上传地址变化且目录只剩一个文件、假图片 415、3MB 文件 413 且带 `maxBytes`。
