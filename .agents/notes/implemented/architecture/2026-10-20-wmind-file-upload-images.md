# Agent Note: 文件上传接口与 XMind 图片还原（M4.2b）

Status: implemented

## Problem

XMind 的图片不在 `content.json` 里，而是以 zip 条目 `resources/xxx.png` 的形式和一份 `xap:resources/xxx.png` 的引用字符串配合存在。M4.2 解析时把 `image.src` 原样写进文档，产出的 `.wmind` 里就带着一个指向包内路径的字符串——离开 zip 之后它什么都指不到。

要真正还原，需要三件事同时成立：

- **服务端得能收图**。之前只有 `POST /users/me/avatar`，它把文件当头像处理（固定存储键、覆盖旧文件），拿来做通用图片存储会把所有人的头像互相顶掉。
- **解析必须仍然是同步的**。M4.1~M4.4 的整个测试策略建立在「`importRegistry.run()` 一行到底、纯函数、可断言」之上。为了几张图片把它变成 async，等于让 60 多个导入测试全部改写，还会让「50MB 文件不卡死」的推理多出一个并发维度。
- **画布得能画图**。布局层 `TopicSize` 只有宽高和折行文本，渲染层 `TopicNode` 只画文字。文档里有 `image` 字段，但它是死数据——不渲染等于没还原。

另外还有几个只在真机上才会暴露的坑：图片尺寸来自用户文件（可能是 `0`、负数、`Infinity`、或者 5000px）；图片数量可能上千；上传会撞限流。

上传成功后返回的是 `/uploads/...`，不在 `/api/` 前缀下。生产 Web 容器只有静态前端，不能从自身磁盘读取 API 的上传文件；缺少这条反向代理时，头像和导入图片会被 SPA 回退成 `index.html`。

## Decision

### 后端：按解码结果判类型，不信任文件名与 `Content-Type`

```go
info, err := imageproc.Inspect(data, maxPixels)   // image.DecodeConfig
```

`Inspect` 用 `image.DecodeConfig` 而不是完整 `Decode`：只读文件头拿格式与尺寸，内存是常数。存盘的扩展名取自**解码出来的格式**，不是上传时的文件名——一个叫 `photo.png` 的 JPEG 会存成 `.jpg`，因为它确实是 JPEG。

像素上限（`maxFilePixels = 40_000_000`）和字节上限（8MB）是两条独立的闸门。只卡字节不够：一张 10000×10000 的纯色 PNG 压缩后只有几十 KB，解码出来是几百 MB。这类「尺寸炸弹」用字节数是拦不住的。

### 后端：文件名用 128 位随机串，不用 ULID

此处的公开读取理由由[私有媒体授权](../../implemented/bug-fix/2026-10-26-wmind-private-media-access.md)部分取代：随机量继续防枚举，新文件额外绑定服务端属主，读取逐次鉴权；保留下面的历史取舍，不能再用“随机不可猜”代替授权。

`/uploads` 是公开可读的（图片要能在 `<image href>` 里直接用，不能带 cookie），URL 本身就是唯一的凭证。ULID 前 48 位是时间戳，同毫秒内生成的 ID 前缀相同，剩下的随机位不足以当凭证用。`id.Random()` 用 `crypto/rand` 出 32 位十六进制，128 位全随机。

### 部署：上传路径由 API 提供，Nginx 保留完整 URI 转发

`deploy/nginx.conf` 对 `/uploads/` 使用 `^~` 前缀代理至 `http://api:8080`，`proxy_pass` 不附加 URI，避免剥掉 API 静态路由要求的 `/uploads/` 前缀。上传资源不经过 Web 容器静态目录、字体扩展名正则或 SPA 回退；不存在的文件保留 API 的 404。开发 Vite、Web 镜像和部署包必须使用相同的路径契约；发布打包复用同一份 Nginx 配置。

### 后端：限流按用户，120 次/分钟

上传是**按人成批**发生的（一次导入会串行传完所有图），按 IP 限流会让同一个出口 IP 下的同事互相拖累。额度与前端的 `IMPORT_LIMITS.maxAssets`（100 张）是一对：必须装得下一次完整导入，否则用户在第 101 张之后只能看着「图片未能还原」。这两个数字改一个必须同时改另一个，两边都写了这条注释。

### 前端：解析同步攒字节，异步收尾换 URL

```ts
ctx.asset({ ref, bytes, fileName, mime })   // 解析阶段：登记 + 返回是否收下
finalizeImport(result, { upload })          // 收尾阶段：串行上传 + 改写 src
```

适配器把图片字节交给 `ctx.asset()`，`src` 先留原始引用当占位符。`ctx.asset()` 返回 `boolean`：超过 `maxAssets` 时返回 `false`，适配器据此**不写**这个 `image` 并计入 `image-skipped`——留一个永远不会被替换的占位符比丢图更糟。

`finalizeImport` 串行上传（不是 `Promise.all`）：限流按次数算，并发只会让一批请求同时撞 429 然后一起失败；串行至少能把额度用满，而且同时只持有一份字节。

失败处理分两种：单张失败 → 摘掉 `topic.image`（不留死链）并计入 `image-skipped`；撞 `RATE_LIMITED` → 立刻停手，剩下的全部记为失败。继续传只会继续拿 429，把对话框永久卡在「正在上传」。

收尾后要**重算摘要**：所有图片都没传成功时，还勾着「已还原：图片」就是在撒谎。

### 前端：图片只等比缩小，尺寸来自文档但要有防线

`imageDisplaySize()` 把 `image.width/height` 夹到 320×240 以内，只缩不放。XMind 会把用户拖出来的尺寸写进文件，那个值有时是原图像素；不夹一下，一个 5000px 高的节点会把整张画布撑到没法看，「缩放到适应」也会把别的节点缩成一个点。

缺一边按 4:3 补，两边都缺用 120×80，`Number.isFinite` 之外还要挡住负数与 `Infinity`——这些值来自用户文件。

`TopicSize.image` 只给尺寸不给坐标：坐标依赖盒子最终位置，而测量发生在盒子摆好之前。渲染层用「盒子 + 尺寸」自己算，两边不会各算一遍而错位。

### 前端：文本与图片作为一个整体居中

```ts
contentHeight = 文本高 + imageGap + 图片高;
contentTop = box.y + (box.height - contentHeight) / 2;
```

沿用「文本中心对齐盒子中心」会把文字压到图片上。编辑态浮层同理，高度要取整个 `box.height`，否则双击带图节点时输入框只盖住文字那一块。

## Consequences

- `POST /api/v1/files` 上线：auth 必需、20 次/分钟/用户 → **120 次/分钟/用户**、8MB、40M 像素、`png/jpeg/gif/webp`。返回 `{ uid, url, width, height, format, bytes }`。
- 新增 `internal/imageproc`（`Inspect` / `ExtensionFor`）与 `internal/service/file.go`（`FileService.Upload`）。`imageproc` 不认识存储，`FileService` 不认识 HTTP，`handler` 不认识像素——三层各自可测。
- 新增 `frontend/src/lib/api/files.ts`、`frontend/src/editor/import/finalize.ts`。
- `ImportResult` 多一个 `assets: ImportAsset[]`；`ImportContext` 多一个 `asset()`。三个适配器里只有 XMind 现代格式在用（Markdown 的相对路径图片暂时还进 `image-skipped`，等 M4.5 之后再看要不要按文件名从同目录找）。
- 布局与渲染支持图片：`IMAGE_METRICS`、`TopicSize.image`、`TopicNode` 的 `<image>` 输出。
- `vite.config.ts` 与生产 Nginx 均代理 `/uploads`；API 持有上传卷，Web 容器不增加共享上传卷。`deploy/nginx.test.mjs` 先复现缺失代理的失败，再验证优先级、完整 URI、404 不回退，以及包内配置与 Web 镜像配置一致。
- 前端 664 个测试、后端全包、`dialectcheck` 全绿。

## Alternatives considered

**把上传卷同时挂给 Web 容器由 Nginx 直接读文件**：减少 API 转发成本，但会让 SQLite 和 PostgreSQL 两套部署都暴露额外的存储布局与权限约束，独立 API 部署也不能复用；沿用 API 的公开静态路由只需补齐已有的反代契约。

**在适配器里直接 `await upload()`**：会让 `parse` 变成 async，`registry.run()` 跟着变 async，60 多个导入测试全部要改；而且解析期间会长时间持有网络等待，与「同步解析、让出一帧」的设计冲突。

**把图片转成 base64 存进文档**：`.wmind` 文档要存进数据库、要能导出、要能分享。一张 2MB 的图变成 2.7MB 的字符串，一份带 50 张图的文档就是 135MB 的 JSON。而且 base64 在文档里没有尺寸信息，布局还得再解一次。

**上传失败就整份导入失败**：图片是附属信息，节点、备注、联系已经解析好了。丢一张图让用户重来一遍，代价远大于收益。

**像素上限用字节上限代替**：见上，纯色大图压缩后极小，字节数拦不住尺寸炸弹。

**图片尺寸不夹**：文件里的值可能是原图像素，一个节点撑满整个画布。夹到 320×240 与节点文本最大宽度一致，视觉上也更像 XMind。

**渲染层自己算图片尺寸**：会和测量层各算一遍，两边一旦有出入就是文字与图片重叠。尺寸在测量阶段定死、坐标在渲染阶段算，是唯一不会错位的分法。
