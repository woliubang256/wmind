# Agent Note: 前端安全依赖定向修补与 Vitest 4 验证边界

Status: implemented

## Problem

依赖审计把生产 XML 解析告警定位到 MathJax 的间接依赖，把开发环境告警定位到 Vitest、mocker 和 tinypool。普通更新不能解除 speech-rule-engine 对 xmldom 0.9.10 的精确锁定；直接更换构建器、路由与 MathJax 主版本又会扩大本次权限安全修复的回归范围。

## Decision

对 `speech-rule-engine>@xmldom/xmldom` 定向覆盖为 0.9.12，继续使用 MathJax 3.2.2。Vitest 升至 4.1.12，继续沿用 Node 环境与现有 Vite 6 配置；类型检查、全部单元测试、生产构建和完整依赖审计共同证明迁移兼容。React Query 与 Zustand 仅接受同主版本补丁。

## Alternatives considered

- MathJax 4 与 speech-rule-engine 最新候选能够一起更新上游依赖，但前者需要改变公式深层导入、预构建与导出，后者当前最新标签仍为预发布；本次先用最小的锁图修补消除已知告警。
- Vitest 5 可以取得最新测试框架，但安全修复不要求跨两代升级，且会同时改变运行要求和测试行为；先迁移到兼容 Vite 6 的 Vitest 4，并保留既有测试作为行为基线。
- 维持 Vitest 3 改动最少，但会保留开发与 CI 环境已知告警，因此不作为长期基线。

## Verification

- 独立干净目录执行 `pnpm install --frozen-lockfile` 成功，锁文件只有 xmldom 0.9.12，且已移除 tinypool。
- `pnpm typecheck && pnpm test && pnpm build` 通过：97 个测试文件、1362 项测试覆盖现有公式与导出行为；生产构建仍提示既有 MathJax/PDF 大 chunk。
- 修改前完整 audit 发现 18 条记录；修改后为 0，包含生产与开发依赖。
- Docker 构建阶段一并复制 `pnpm-workspace.yaml`，使精确 override 在冻结安装中生效。

## Consequences

本次保留构建器与公式 API，消除审计告警并减少迁移范围。代价是维护一条上游精确依赖覆盖；MathJax 后续升级时需检查并移除不再必要的 override。Vitest 主版本的 mock 与 worker 行为由现有全量测试验证；未将构建 chunk 体积告警当成新的安全告警。
