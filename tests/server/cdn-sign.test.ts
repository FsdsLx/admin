import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isSignableCdnPath, signCdnPath, verifyCdnSignature } from "../../app/server/src/lib/cdn-sign";
import { testApp, testConfig } from "./helpers";

/** 与 testApp 同一组必填 env；需要单独构造 config 的用例用它。 */
const baseEnv = {
  NODE_ENV: "test", PUBLIC_ORIGIN: "https://example.test",
  FORUM_DB_PATH: "/nonexistent/never-open-legacy-forum.db",
  SESSION_SECRET: "isolated-cdn-test-secret-at-least-32",
  ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  OAUTH_CLIENT_ID: "test-client", OAUTH_CLIENT_SECRET: "test-only-placeholder", POW_DIFFICULTY: "0",
};
const KEY = "test-cdn-sign-key-at-least-16";
const enabledEnv = { CDN_SIGN_ENABLED: "enabled", CDN_SIGN_KEY: KEY };

/** 造一个真实会话（不连 GitHub：会话行直接写库）。 */
const signedIn = (app: Awaited<ReturnType<typeof testApp>>["app"]) => ({ cookie: `sid=${app.services.auth.createSession("zhang-san", 4242, null, "provider-token")}` });
const tokenOf = (url: string) => new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("token") ?? "";

describe("受保护资源的路径白名单", () => {
  it("图片、音视频与附件可以签", () => {
    for (const path of ["/yzgc/static/site/private/a.png", "/x/b.JPEG", "/x/c.webp", "/v/clip.mp4", "/d/paper.pdf", "/d/sheet.xlsx"]) {
      expect(isSignableCdnPath(path), path).toBe(true);
    }
  });

  it("构建期资源不签（它们走长缓存，不受签名影响）", () => {
    for (const path of ["/assets/index-a1b2c3.js", "/assets/index-a1b2c3.css", "/f/x.woff2", "/f/x.ttf", "/f/x.otf", "/x/favicon.ico", "/x/data.json"]) {
      expect(isSignableCdnPath(path), path).toBe(false);
    }
  });

  it("站外地址、带查询或锚点、含 .. 或反斜杠、没有扩展名的一律拒绝", () => {
    const rejected: unknown[] = [
      "https://evil.test/a.png", "//evil.test/a.png", "/a.png?x=1", "/a.png#frag",
      "/a/../b.png", "/a\\b.png", "a.png", "/dir/", "/dir/.png", "/dir/a.", 42, null, undefined, "",
    ];
    for (const path of rejected) expect(isSignableCdnPath(path), String(path)).toBe(false);
  });
});

describe("签名算法", () => {
  it("token = base64url(HMAC_SHA1(key, path + '?e=' + expire))，expire = 现在 + TTL", () => {
    const now = 1_700_000_000_000;
    const { url, expire } = signCdnPath({ path: "/a/b.png", key: KEY, ttlSeconds: 300, now });
    expect(expire).toBe(Math.floor(now / 1000) + 300);
    const expected = createHmac("sha1", KEY).update(`/a/b.png?e=${expire}`).digest("base64url");
    expect(url).toBe(`/a/b.png?e=${expire}&token=${expected}`);
    // 独立重算一遍能验过；结果里不含密钥
    expect(verifyCdnSignature({ path: "/a/b.png", expire, token: tokenOf(url), key: KEY })).toBe(true);
    expect(url).not.toContain(KEY);
  });

  it("换密钥、换路径、改到期时间或截断 token 都验不过", () => {
    const { url, expire } = signCdnPath({ path: "/a/b.png", key: KEY, ttlSeconds: 300, now: 1_700_000_000_000 });
    const token = tokenOf(url);
    expect(verifyCdnSignature({ path: "/a/b.png", expire, token, key: `${KEY}-other` })).toBe(false);
    expect(verifyCdnSignature({ path: "/a/c.png", expire, token, key: KEY })).toBe(false);
    expect(verifyCdnSignature({ path: "/a/b.png", expire: expire + 1, token, key: KEY })).toBe(false);
    expect(verifyCdnSignature({ path: "/a/b.png", expire, token: token.slice(0, 8), key: KEY })).toBe(false);
  });
});

describe("配置项", () => {
  it("默认关闭、不需要密钥，TTL 默认 300", () => {
    expect(testConfig({ ...baseEnv }).cdnSign).toEqual({ enabled: false, key: "", ttlSeconds: 300 });
  });

  it("打开时密钥太短直接拒绝启动，不静默降级", () => {
    expect(() => testConfig({ ...baseEnv, CDN_SIGN_ENABLED: "enabled" })).toThrow(/CDN_SIGN_KEY/);
    expect(() => testConfig({ ...baseEnv, CDN_SIGN_ENABLED: "enabled", CDN_SIGN_KEY: "short" })).toThrow(/CDN_SIGN_KEY/);
    expect(testConfig({ ...baseEnv, ...enabledEnv }).cdnSign.enabled).toBe(true);
  });

  it("TTL 只能是 300–600 秒（与七牛控制台的有效期对得上）", () => {
    expect(() => testConfig({ ...baseEnv, CDN_SIGN_TTL_SECONDS: "120" })).toThrow(/300 to 600/);
    expect(() => testConfig({ ...baseEnv, CDN_SIGN_TTL_SECONDS: "900" })).toThrow(/300 to 600/);
    expect(() => testConfig({ ...baseEnv, CDN_SIGN_TTL_SECONDS: "300.5" })).toThrow(/300 to 600/);
    expect(testConfig({ ...baseEnv, CDN_SIGN_TTL_SECONDS: "600" }).cdnSign.ttlSeconds).toBe(600);
  });
});

describe("GET /api/cdn/sign", () => {
  it("默认关闭：回 503 并说明原因，即使配了密钥也一样", async () => {
    const { app, close } = await testApp({}, false, { CDN_SIGN_KEY: KEY });
    const response = await app.inject({ url: "/api/cdn/sign?path=/a/b.png", headers: signedIn(app) });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "cdn_sign_disabled" });
    await close();
  });

  it("打开后未登录不签发（谁都能签的接口等于没有保护）", async () => {
    const { app, close } = await testApp({}, false, enabledEnv);
    const response = await app.inject({ url: "/api/cdn/sign?path=/a/b.png" });
    expect(response.statusCode).toBe(401);
    await close();
  });

  it("打开后登录用户拿到带签名的地址，响应里没有密钥", async () => {
    const { app, close } = await testApp({}, false, enabledEnv);
    const response = await app.inject({ url: `/api/cdn/sign?path=${encodeURIComponent("/yzgc/static/site/private/photo.png")}`, headers: signedIn(app) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { url: string; expire: number };
    expect(body.url.startsWith("/yzgc/static/site/private/photo.png?e=")).toBe(true);
    expect(body.expire).toBeGreaterThan(Math.floor(Date.now() / 1000) + 250);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(verifyCdnSignature({ path: "/yzgc/static/site/private/photo.png", expire: body.expire, token: tokenOf(body.url), key: KEY })).toBe(true);
    await close();
  });

  it("构建期资源、站外地址与缺 path 都被拒", async () => {
    const { app, close } = await testApp({}, false, enabledEnv);
    const headers = signedIn(app);
    for (const path of ["/assets/index-a1b2c3.js", "/assets/index-a1b2c3.css", "https://evil.test/a.png", "/a/../b.png"]) {
      const response = await app.inject({ url: `/api/cdn/sign?path=${encodeURIComponent(path)}`, headers });
      expect(response.statusCode, path).toBe(400);
      expect(response.json().error, path).toBe("not_signable");
    }
    const missing = await app.inject({ url: "/api/cdn/sign", headers });
    expect(missing.statusCode).toBe(400);
    await close();
  });
});
