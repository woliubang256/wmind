# Agent Note: 分享密码持久明文回显

Status: implemented

## Problem

用户反馈分享密码查看一次后无法再次查看，并明确接受分享访问码以明文保存。当前代码没有一次性查看开关，但管理端每次读取依赖解密：密钥变化或不可用时只返回 null，访客 bcrypt 校验仍可通过。这个依赖与轻量访问码应能反复复制的要求不符；本地不能据此断言线上发生过密钥变化。

## Decision

新建及重设分享密码保存 `plain:<原密码>`，bcrypt 仍独立负责访客验证。沿用历史 `password_ciphertext` TEXT 列和领域字段名，以格式标记区别旧 `v1:` 密文，不新增迁移、不改变备份 schema。原密码即使以 `v1:` 或 `plain:` 开头也只去掉最外层一次标记。新值的查看、创建及重设不依赖加密器，登录密码、2FA 和备份凭据的加密规则不变。

旧 `v1:` 继续使用现有解密器读取，不自动写库；旧哈希、未知格式、损坏或失去旧密钥时保持原访问保护并允许属主重设。其他设置修改保留原存储值，清密码同时清空哈希及可读副本。

只有属主接口返回密码并使用 no-store；公开查询不读取可读副本，DTO、审计和日志不暴露密码。查看和复制不能消费密码；保持原 psw 预填、地址清理及不写浏览器存储的行为。

## Related decisions

- [分享密码管理](../feature/2026-10-25-wmind-share-password-management.md)部分重叠：仅取代新密码必须加密落库的决定，保留随机生成、属主授权、psw 和旧数据兼容边界，双向链接。
- [分享架构](../architecture/2026-10-21-wmind-share-links.md)与[早期分享提案](../../proposed/architecture/2026-10-16-wmind-share-link.md)保留公开只读、bcrypt、失效及 ACL 取舍，不替代。
- [分享默认值](../feature/2026-10-24-wmind-share-form-defaults.md)保留默认值与草稿规则；登录加密、2FA 和备份的密钥规则无关，不调整。

## Alternatives considered

- 保留 AES-GCM 并要求稳定密钥，可降低数据库泄露时直接暴露密码的风险；但用户已接受明文且希望去掉回显对密钥的依赖，本次不用于新值，仅保留旧数据读取。
- 新增专用明文列，字段语义最直接；但需要双方言迁移、生成代码和备份 schema 变化。现有 TEXT 列可用明确标记兼容两种表示，因此保留历史列并同步文档说明。
- 查看时自动把旧密文回写明文，可减少旧数据对密钥的后续依赖；但会让读接口产生写入并引入与重设的竞态，故旧数据只读兼容、显式重设后改为明文。

## Verification

- `TestSharePasswordRemainsReadableWithoutOriginalKey` 先复现更换密钥后回显为 null、未配置旧加密器时构造失败；修改后通过。新值测试覆盖明文实际存储、Unicode 与 `v1:` / `plain:` 原密码前缀不被误解。
- `go test ./internal/service -run 'TestShare(Password|OwnerLegacyPasswordRecovery|Update)' -count=1` 覆盖两类列表重复读取、访客验证和浏览、旧密文、仅哈希、错误密钥、未知版本、重设、清除和无关设置更新。
- `go test ./internal/integration ./internal/httpapi -run 'TestSharePasswordPersistsAcrossDatabaseReopens|TestShareOwnerCanReadAndResetPassword' -count=1` 使用真实 SQLite，数据库反复关闭重开并替换/移除旧密钥后仍可读回。公开查询不读取可读副本，HTTP 公开与越权响应不暴露密码，账号密码哈希不变。
- `frontend/e2e/share-password-management.mjs` 覆盖分享弹窗两次关闭重开、刷新重开与“我的分享”刷新后的重复复制，独立验证空的新建草稿不影响已有密码。旧脚本将带 dialog 作用域的定位器嵌入行内 has 过滤而超时，现用行内相对 data-share-password 定位。原 psw 预填、URL/Referer 清理、旧哈希重设和中英文窄屏回归通过。
- 本地前端类型检查、95 文件 1355 项单测和生产构建、后端全量测试与 vet、12 项发布工具测试、配色和字体门禁通过。PostgreSQL 实库、生成代码和 Docker 整栈由标签发布 CI 再验证。

## Consequences

数据库与备份能直接读到新分享密码，分享码不应复用账号密码。旧密钥丢失不能还原旧密文，需重设一次。旧程序不识别 `plain:`，回滚旧构建时访客 bcrypt 仍有效但管理端不能回显。若以后分享用于高敏资料或要求加密静态数据，应重新评估专用加密与密钥轮换，不能静默恢复旧限制。
