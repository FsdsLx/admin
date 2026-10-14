import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/require-auth.js";
import { isSignableCdnPath, signCdnPath } from "../../lib/cdn-sign.js";

/**
 * 受保护资源的 CDN 签名地址（#227）：`GET /api/cdn/sign?path=<站内相对路径>`。
 *
 * 默认关闭：`CDN_SIGN_ENABLED` 打开且配好 `CDN_SIGN_KEY` 才签发，关闭时回 503 并说明原因；
 * 关闭状态下服务不要求密钥，照常启动。**需要登录**——服务端签的是「当前这个人」的临时地址，
 * 一个谁都能调的签名接口等于没有保护。只签图片/音视频/附件（见 lib/cdn-sign.ts 的白名单），
 * js/css/字体不签：它们走构建期 CDN 前缀 + 长缓存，不经过这里。
 * 密钥只从 config 来，永远不出现在响应、错误或日志里。
 */
export default async function cdnRoutes(app: FastifyInstance) {
  const { config } = app.services;
  app.get<{ Querystring: { path: string } }>(
    "/api/cdn/sign",
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!config.cdnSign.enabled) {
        return reply.code(503).send({ error: "cdn_sign_disabled", message: "CDN 签名没有启用。" });
      }
      const path = req.query.path;
      if (!isSignableCdnPath(path)) {
        return reply.code(400).send({ error: "not_signable", message: "只对受保护的图片、音视频与附件签发地址。" });
      }
      return signCdnPath({ path, key: config.cdnSign.key, ttlSeconds: config.cdnSign.ttlSeconds });
    },
  );
}
