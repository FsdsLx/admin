import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 受保护资源的 CDN 时间戳签名（#227）。
 *
 * 七牛侧启用「时间戳防盗链」后，受保护资源的地址必须带 `?e=<到期秒>&token=<签名>`：
 * `token = base64url(HMAC_SHA1(CDN_SIGN_KEY, path + "?e=" + e))`。密钥只在服务端，绝不下发前端。
 * 本文件是纯函数：不读 config、不碰网络、不写日志；调用方见 routes/portal/cdn.ts。
 */

/** 需要签名才能访问的资源：图片、音视频与附件。构建期资源（js/css/字体）不签，保持长缓存。 */
const PROTECTED_EXTENSIONS = Object.freeze([
  "png", "jpg", "jpeg", "webp", "avif", "gif", "svg",
  "mp4", "webm", "mov", "m4v", "mp3", "m4a", "wav",
  "pdf", "zip", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "md", "txt",
]);

/**
 * 这条路径能不能签发：必须是站内相对路径（`/...`）、没有查询串与锚点、没有 `..` 或反斜杠，扩展名在白名单里。
 * 拒绝绝对地址与协议相对地址（`//host/...`），避免这个接口被用来给站外地址签名（开放重定向/越权租用）。
 */
export function isSignableCdnPath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return false;
  if (/[?#]/.test(path) || path.includes("..") || path.includes("\\")) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return PROTECTED_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

export type SignedCdnUrl = { url: string; expire: number };

/** 生成受保护资源的带签名地址；`expire` 是 Unix 秒，等于「现在 + TTL」。 */
export function signCdnPath(input: { path: string; key: string; ttlSeconds: number; now?: number }): SignedCdnUrl {
  const expire = Math.floor((input.now ?? Date.now()) / 1000) + input.ttlSeconds;
  const token = createHmac("sha1", input.key).update(`${input.path}?e=${expire}`).digest("base64url");
  return { url: `${input.path}?e=${expire}&token=${token}`, expire };
}

/** 按同一算法独立重算一遍再比对（测试与排查用）。长度不同直接返回 false，等长时用定时安全比较。 */
export function verifyCdnSignature(input: { path: string; expire: number; token: string; key: string }): boolean {
  const expected = createHmac("sha1", input.key).update(`${input.path}?e=${input.expire}`).digest("base64url");
  const left = Buffer.from(expected);
  const right = Buffer.from(String(input.token ?? ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
