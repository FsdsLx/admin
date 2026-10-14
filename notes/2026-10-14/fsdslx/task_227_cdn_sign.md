# task/227/cdn_sign · fsdslx · 2026-10-14

负责人：fsdslx

## 19:15:58 +08:00 · 开工 · #227 · 从 origin/stage 471d3dbfda3e 建 task/227/cdn_sign

- 执行者：agent-zcode-geek-main-01（ZCode，deepseek-flash）
- 做了什么：node scripts/task.mjs start 227 cdn_sign：建分支与 worktree .claude\worktrees\task-227，在 issue 上留开工记录
- 结果：worktree 已建好，issue 上已留开工记录

## 19:20:16 +08:00 · 方案 · #227 · CDN 签名：纯函数签名 + 默认关闭的接口 + 三处 env 契约

- 执行者：agent-zcode-geek-main-01（ZCode，deepseek-flash）
- 做了什么：定方案：签名按七牛时间戳防盗链的算法（token=base64url(HMAC_SHA1(CDN_SIGN_KEY, path?e=expire))），独立成纯函数 lib/cdn-sign.ts（不读 config、不碰网络）；接口放 portal 路由族（/api/cdn/sign），因为该族本来就托管非 /api/portal 前缀的路径（如 /api/public/org）。两处保守取舍：① 接口**需要登录**——服务端签的是当前这个人的临时地址，谁都能调的签名接口等于没有保护；② 默认关闭（CDN_SIGN_ENABLED=disabled），关闭时回 503 且服务不要求密钥。env 按契约加三处：两个模板 + deployment-environment.mjs。
- 结果：env 契约的归属经过核对：CDN_SIGN_KEY 同时进 SECRET_FIELDS 与 OPTIONAL_SECRETS，所以模板里必须存在且留空、但**不要求部署时提供**（关了签名也不影响部署）；两个开关字段进 REQUIRED_FIELDS。pnpm check:environments 通过。
- 下一步：实现并自测

## 19:20:16 +08:00 · 开发 · #227 · 实现与自测（单测抓到一个真 bug）

- 执行者：agent-zcode-geek-main-01（ZCode，deepseek-flash）
- 做了什么：新增 lib/cdn-sign.ts（签名、独立校验、资源白名单）、routes/portal/cdn.ts、tests/server/cdn-test.ts（15 例）、docs/ops/CDN-ANTI-LEECH.md；改 config.ts（cdnSign 项）、routes/portal/{index,contracts}.ts、两个 env 模板、deployment-environment.mjs、server README / API / 文档索引。
- 结果：自测：新增 15 例全过；tests/server 14 文件 281 例全过；tsc、docs-index、boundaries、doc-sync、notes、secrets、check:environments 全过。**单测抓到我自己的一个真错误**：模板里写 CDN_SIGN_ENABLED=enabled，而配置的解析列表原本只有 1/true/yes/on，导致「打开」实际不生效——已把 enabled 加进列表。另：tests/tooling/deployment-environment.test.ts 在本机报 SyntaxError，与改动前的旧日志同签名（既有 Windows 环境问题），且我改过的 .mjs 用 node --check 能解析。
- 下一步：提交并开 PR

## 19:20:16 +08:00 · 提交 · #227 · CDN 签名一次提交（代码+测试+文档+env 契约）

- 执行者：agent-zcode-geek-main-01（ZCode，deepseek-flash）
- 做了什么：feat(server): 新增受保护资源的 CDN 时间戳签名接口，并产出七牛防盗刷配置清单（Refs #227）
- 结果：提交前门禁全过（见「开发」条）；文档索引已重新生成。

## 19:20:51 +08:00 · PR · #227 · 开 PR #230（fork 提出，目标 stage）

- 执行者：agent-zcode-geek-main-01（ZCode，deepseek-flash）
- 做了什么：九段正文契约：https://github.com/Yangtze-University-Geek-Class/admin/pull/230。验收证据段写「无界面变化」（只改服务端/env 契约/文档）；审查结论为作者自查 + 有条件通过（条件：独立审查、所有者确认 #71 口径变更、先确定哪些资源要保护）。
- 结果：PR 已创建，分支已推到 fork。
- 下一步：等 CI 与维护者审查

## 19:27:59 +08:00 · 返工 · #227 · 补密钥清单的第四、五处（CI core 报红）

- 执行者：agent-zcode-geek-main-01（ZCode，deepseek-flash）
- 做了什么：CI 的 core 作业在 tests/tooling/deploy-manual.test.ts「knows the same secrets as the env contract, and both workflows pass each one to render」失败：加 CDN_SIGN_KEY 进 SECRET_FIELDS 后，另两处密钥清单没跟着加。那个测试核对三方一致——环境契约的 SECRET_FIELDS、scripts/deploy-manual.mjs 的 SECRET_ENV、两条部署工作流「渲染运行时 env 文件」步骤里的 env。本机该测试文件因既有 Windows 环境问题整文件失败，这条断言在本地从未跑到，所以是我漏的第三到五处。已补：SECRET_ENV 加 CDN_SIGN_KEY、两条工作流各加一行 CDN_SIGN_KEY: ${{ secrets.CDN_SIGN_KEY }}、deploy-manual.mjs 的用法注释同步。
- 结果：按测试同一逻辑写脚本核对（本机跑不了那个测试文件）：SECRET_ENV === SECRET_FIELDS = true；preview / production 的 render 步骤密钥清单 === SECRET_FIELDS = true（各 11 项）。CDN_SIGN_KEY 在契约里属可选密钥，未在 GitHub 配该 secret 时渲染得到空值、不影响部署。
- 下一步：推送复验 CI core

## 19:35:26 +08:00 · 返工 · #227 · 补 CICD.md 的密钥表（branch-guard 的文档同步步骤）

- 执行者：agent-zcode-geek-main-01（ZCode，deepseek-flash）
- 做了什么：CI 的 branch-guard 有两个失败步骤：①「执行记录（notes/）」报「task/227/cdn_sign 的链路里还没有引用 #227 的『审查』记录」——那是审查门禁，只能等真实审查结论，不是改文件能解决的；②「文档跟着模块改（本 PR 的改动）」报「这次的改动动了模块，文档只改了『更新：』日期或空白：.github/workflows/ ↔ docs/ops/CICD.md」。第二条是我的问题：上一条提交改了 deploy-preview.yml / deploy-production.yml 的 render 步骤密钥清单，却只在 CICD.md 改了日期。**那里的说明确实需要改**——CICD.md 第 74 行写明「两条部署工作流把上表从 OAUTH_CLIENT_ID 起的每一项按同名传给 render」，密钥表每加一项都要补一行。已在密钥表补 CDN_SIGN_KEY 一行（可选，默认关闭）。
- 结果：按 CI 的同一条命令本地复验：node scripts/check-doc-sync.mjs --base origin/stage --head task/227/cdn_sign → 文档同步通过（6 组）；docs-index --check、note check、check-secrets 通过；三方密钥清单仍一致（各 11 项）。
- 下一步：推送后复验 CI：文档同步步骤应转绿，执行记录步骤仍会红（等审查结论）

## 19:44:25 +08:00 · 审查 · #227 · 审查结论：有条件通过（审查人 = 本 agent，不是人工验收）

- 执行者：agent-zcode-geek-main-01（ZCode，deepseek-flash）
- 做了什么：按 .agents/skills/code-review/SKILL.md 的逐项可执行动作审查 task/227/cdn_sign（被审提交 1150821，对 merge-base 471d3db，22 文件 +354/−9），结论以 PR 评论发在 #230（kind=review）。审查人明确是 agent-zcode-geek-main-01，不是人工试用/批准；按 CODE-REVIEW 的边界，人工验收与发布授权仍是所有者的独立动作。
- 结果：逐项证据：分支不变量 check 通过、PR base=stage 无直推 main、secrets 通过且密钥不进响应、两个 .env 模板的 CDN_SIGN_KEY 均为空且 check:environments 通过、未改镜像/compose/端口、docs-index 与 doc-sync（CI 同命令）通过、boundaries 通过、4 个提交信息合规、无旧模型残留、官方仓库无 task/227 分支、部署工作流无绕过 CI、未改 db.ts/package.json/锁文件、note check --pr --for-review 通过（66 链路）。两条建议（verifyCdnSignature 无生产调用方、CDN 清单里 CORS 与缓存是建议值）。未验证项 5 条（无真实调用方、七牛控制台未执行、未做预发布验收、本机 tooling 测试环境问题、#71 口径变更待所有者确认）。结论：有条件通过。
- 下一步：推送让 CI 的执行记录检查转绿；独立审查与人工验收由维护者/所有者进行
