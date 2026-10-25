# Agent Note: 分享密码的属主可见管理与链接预填

Status: implemented

## Problem

分享目前只能手填密码，管理列表只知道是否设置密码。用户无法再复制原密码，也无法通过链接预填。生成长度曾与账号密码策略混淆；分享的轻量访问门槛默认应为 4 位。

## Decision

分享密码验证和属主查看分离：bcrypt 保持原来的公开验证职责，另加密文提供可查看的属主 API。分享密码下限保持4位，与账号密码策略无关。

随机生成默认4位，以浏览器 crypto.getRandomValues 无偏采样并拒绝不含全部三类的候选，保证大小写字母和数字齐全；熵源不可用时明确报错，不回退 Math.random。新建保留空密码和手动输入。输入框右侧放生成按钮，两处管理入口共用行内密码控件和重设弹窗，避免新增独占整行的说明或重复“需要密码”标签；明文只留内存，不写浏览器持久存储。旧密码不可查看时明确提示并允许重设，已撤销行不提供重设。

可读密码由复制链接函数编码为 psw，保留其他查询与hash，不给非HTTP地址追加密码。公开页只预填、不自动验证；读取后replace清除全部psw并保留其他参数与hash。按分享token隔离组件状态，地址变化不会把上张分享的密码或凭证带入新分享；预填只存内存，sessionStorage仅保存验证后的访问令牌。浏览器页面和Web响应使用strict-origin引用策略，内置Nginx访问日志仅记录不带query的URI且不含Referer，应用日志屏蔽psw。外部代理、异常日志、发送方和浏览器初始导航仍可能记录完整链接，不能承诺消除所有泄露渠道；带密码链接等于同时发送两者。

仅HTML meta不足以保护开发模式：Vite把热更新client注入到meta之前，真实浏览器复现其Referer仍带初始psw。因此dev和preview也设置响应头strict-origin，与生产Nginx一致；测试不排除这个早期子请求。

数据库迁移新增 password_ciphertext，bcrypt password_hash 继续独立负责访客验证。AES-256-GCM 使用现有稳定安全密钥源（专用 2FA 密钥优先、JWT 密钥回退），但以独立用途派生密钥，AAD 绑定分享 UID 与属主。管理端 DTO 的 password 为字符串或 null，仅经过属主过滤后解密，响应 no-store；公开查询不读取密文，公开 DTO 不包含密码、哈希或密文。审计不记敏感值。

旧行不回填虚假密码；旧哈希或密钥变更/密文损坏时仍要求密码，验证继续使用哈希，管理端显示不可查看并允许重设。重设原子写入哈希与密文，其他设置修改保留两者，清密码同时清除两者。密钥必须随部署备份并保持稳定。

## Related decisions

检索 share / 分享密码 / 加密 / psw：

- [分享链接架构](../architecture/2026-10-21-wmind-share-links.md)部分重叠，保留公开访问边界与 bcrypt 验证，新增可逆密文部分取代只保存哈希的限制，互链。
- [早期分享提案](../../proposed/architecture/2026-10-16-wmind-share-link.md)部分重叠，保留其独立只读/ACL理由并互链，不复制成新架构。
- [分享表单默认](2026-10-24-wmind-share-form-defaults.md)部分重叠，保留空密码、7天和草稿保护，互链。
- [双因素认证](2026-10-23-wmind-two-factor.md)、[登录加密](../architecture/2026-10-24-wmind-login-encryption.md)和[备份](2026-10-24-wmind-admin-backup.md)只共享稳定密钥来源；各自用途、密文协议与恢复边界不变，不替代。

## Alternatives considered

- 继续仅存 bcrypt 最小化数据库泄露风险且无需密钥管理，但不能满足管理端查看密码；保留其验证职责，另加仅属主解密的密文。
- 明文保存密码最容易查询且不怕密钥丢失，但数据库和备份泄露会直接暴露密码，不采用。
- 仅前端本地保存能避免后端可逆数据，却无法跨设备查看、刷新丢失且扩大浏览器持久化暴露面，不采用。
- 读取 psw 后自动验证最省一次点击，但打开链接即触发验证并消耗尝试次数，错误链接难以修正，因此只预填。

## Verification

- `go test ./internal/auth ./internal/service ./internal/httpapi ./internal/repository/sqlite -run 'TestShare|TestRepositoryContract' -count=1` 验证密文非明文、随机化、防篡改、防跨属主/分享交换、密钥用途隔离；错误密钥不阻断 bcrypt 和重设。
- HTTP 先复现属主无法查看密码，再验证创建、两类列表、重设、null/省略、越权404、公开隔离与 no-store；仓储契约覆盖双方言密文映射，SQLite覆盖0005旧行升级到0006。
- 前端 `share-password.test.ts` 验证1000份随机结果、三类齐全、无偏采样和安全随机失败；`share-password-management.mjs` 以全拦截夹具覆盖两处管理、旧哈希、失败/取消、刷新、清密码、原生dialog复制降级、中英文375px及明文不进持久化存储。`share-defaults.mjs` 回归默认值与异步草稿保护。
- URL纯函数测试覆盖编码、重复参数、空/超长、伪协议与旧哈希；`share-password-query.mjs` 覆盖只预填、主动错误/正确验证、URL清理/刷新、跨token与同token导航、失效和无密码链接、API URL和子请求Referer不携带psw。应用日志与Nginx访问日志防泄露均先编写失败测试，再修至通过。
- 完整前端95文件1355项测试、类型检查与生产构建通过；后端全量测试、vet、分享auth/service race通过。生成代码无漂移、方言边界、迁移序列、笔记、配色/字体及12项发布工具测试通过。公开预填夹具在dev与生产preview均验证；另回归分享默认、21项画布状态与34项导出品牌策略。PostgreSQL实库结构/契约和Nginx整栈冒烟在发布CI执行，本地未提供PostgreSQL/Docker。

## Consequences

创建者可跨设备读回密码，而数据库不保存明文。可逆存储增加密钥备份责任；失去密钥后可重设但无法恢复旧密码。4位密码熵有限，服务端限流继续生效。复制带密码链接降低了二次传播门槛，不能当作独立通道传密。旧访问凭证仍按已有30分钟有效期处理，重设密码不额外撤销它们，需要立即失效时撤销链接。迁移改变备份结构，ZIP恢复继续要求相同 schema；旧备份须先在相应旧版本恢复后升级。
