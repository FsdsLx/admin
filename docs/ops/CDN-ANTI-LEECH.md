# CDN 防盗刷：七牛控制台配置清单

> 本文件是**配置清单与操作说明**（由维护者在七牛控制台执行），不是已执行的记录；代码侧见 `app/server/src/routes/portal/cdn.ts` 与 `lib/cdn-sign.ts`（#227）。

状态：`current` · 更新：2026-10-14 · 关联：[server 服务合同](../services/server/README.md)、[ENVIRONMENTS](ENVIRONMENTS.md)、[API](../architecture/API.md) · 代码落地与验收：[issue #227](https://github.com/Yangtze-University-Geek-Class/admin/issues/227)

## 现状（改前）

- 域名：`cdn.crosery.com`（七牛）；静态资源前缀 `yzgc/static/site/`，由构建期常量 `scripts/static-cdn-base.mjs` 决定，并与宿主 nginx CSP（`deploy/nginx/production.conf`）和上传脚本三处必须逐字一致。
- 已开 **Referer 防盗链**，但 **空 Referer 放行**、**未启用 URL 签名**：拿到地址的人可以随便刷，Referer 也可以伪造。
- 服务端此前**没有任何** CDN/七牛配置项（唯一带 CDN 的是邮件图片 `MAIL_ASSET_BASE`）；`lib/crypto.ts` 只有 AES-GCM，没有 HMAC，也没有「签发一次性 URL」的接口——签名接口是 #227 新加的。

**一个必须说清的前提**：`/yzgc/static/site/` 下都是**构建期产物**（js/css/字体/图片），它们本来就要给所有人看；真正「受保护」的资源（会员附件、付费内容、私人图片）**目前一个都没有上 CDN**。所以这份清单是**加固与预防**，不是「已经堵住了正在漏的洞」。

## 配置清单

逐项给出「在哪里设」「设成什么」「风险」「回滚」。

| # | 项 | 设成什么 | 风险 | 回滚 |
|---|---|---|---|---|
| 1 | **允许空 Referer** | **关闭**（不再放行空 Referer） | 直接用浏览器打开图片地址、某些客户端（RSS 阅读器、部分 App 内嵌 WebView）不带 Referer，会立刻 403。**必须先确认站内所有资源都经过带 Referer 的页面加载** | 改回放行 |
| 2 | **时间戳防盗链（URL 签名）** | 启用；有效期与 `CDN_SIGN_TTL_SECONDS` **一致**（只能 300–600 秒）；算法选 `HMAC-SHA1(key, path?e=expire)`，token 用 **URL-safe base64** | 开启后**未签名**的旧地址立刻失效；构建期资源（js/css/字体）若也被规则覆盖，站点会白屏。**建议只对受保护路径（如 `yzgc/static/site/private/`）启用签名，构建期目录不启用** | 控制台关掉签名 |
| 3 | **用量封顶 + 告警** | 按流量与请求数设日/月封顶；到 80% 告警、100% 停止服务或降级 | 设太低会误伤正常访问；封顶触发后站点资源不可用 | 提高封顶 |
| 4 | **CC / WAF 防护** | 开基础 CC 防护（单 IP 频率限制），按需开 WAF 规则 | 频率阈值过严会挡住正常用户或爬虫 | 关规则 |
| 5 | **CORS** | 由 `Access-Control-Allow-Origin: *` 收敛为站点域名（`https://yangtzeu.work`、`https://prev.yangtzeu.work`，需要本机联调时另加 `http://127.0.0.1:5173`） | 收敛后：跨域引用资源的第三方页面、以及**非白名单来源**的前端会拿不到资源；字体等资源在跨域下需要 `Access-Control-Allow-Origin` 才生效 | 改回 `*` |
| 6 | **HTTPS / 证书** | 确认 CDN 域名有有效证书，且回源也用 HTTPS | 证书过期会整站资源失败（已有 `Certificate watch` 工作流盯仓库侧，CDN 侧需人工确认） | 续证书 |
| 7 | **缓存策略** | 构建期资源（带内容哈希）可长缓存 `immutable`；**带签名的受保护资源不要设长缓存**（否则过期签名仍被缓存命中，等于签名作废） | 签名资源被长缓存 → 防盗链失效 | 调回短缓存 |

## 代码侧（已交付，#227）

- `GET /api/cdn/sign?path=<站内相对路径>`：登录后调用，返回 `{ url, expire }`，`url` 形如 `<path>?e=<到期秒>&token=<签名>`。**默认关闭**（`CDN_SIGN_ENABLED=disabled`），关闭时回 503；打开需要 `CDN_SIGN_KEY`（≥16 字符，只在 env，进前端会等于没保护）。
- 只签**图片 / 音视频 / 附件**（白名单见 `lib/cdn-sign.ts`）；**js/css/字体不签**——它们走构建期前缀与长缓存，不受本接口影响。
- 未登录不签发；只接受站内相对路径（拒绝绝对地址、`//host`、带查询/锚点、含 `..`）。
- **前端尚未接入**：现在没有页面调用它，也没有受保护资源在 CDN 上。接入需要先确定「哪些资源要保护」，那一步是另一个决定。

## 与既有决定的关系

[issue #71](https://github.com/Yangtze-University-Geek-Class/admin/issues/71)（已关闭）在讨论七牛上传时，正文第 6 条把「私有桶与下载签名」列为**不做**。本清单与 #227 的代码是**新的决定**（按需求方要求做签名接口），因此：

- 在**打开** `CDN_SIGN_ENABLED`、在控制台启用时间戳防盗链之前，需要所有者确认这次口径变更；
- 打开之前，本清单的第 2 项与代码侧都不生效，站点行为与现在一致。

## 未做 / 未验证

- 本清单**没有在七牛控制台执行过**；「线上是否已生效」也**未核验**（需要登录控制台逐项对照）。
- 没有可签的受保护资源，签名接口**没有真实调用方**，所以「打开后站点是否正常」需要在预发布先试。
- CORS 收敛的具体白名单要以实际引用的来源为准，本文件给的是当前站点域名；若将来有第三方嵌入需求，要重新评估。
