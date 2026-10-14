import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { newOpenId } from "./openid.js";

/**
 * 内部身份与第三方凭据的持久化（#226）。
 *
 * 原则：第三方渠道 id 只是**凭据**，`users.id`（内部 OpenID）才是**身份**；1 个用户可挂 N 条 `identities`。
 * provider_uid 只接受不可变 id（GitHub 数字 id），**不用用户名或邮箱**——用户名可以改，邮箱可以换。
 * 本模块只做读写与留痕，不做授权判断；授权仍在 middleware/require-*.ts 与 lib/access.ts。
 * 本阶段（地基）不改变任何现有接口行为：会话的读写仍以 `sessions` 旧列为准，`openid`/`provider` 只双写。
 */

/** 渠道名。本阶段只有 GitHub；新增渠道时在这里加，并同步「新身份策略」。 */
export type Provider = "github";
export const GITHUB_PROVIDER: Provider = "github";

/** 回填只做一次，标记沿用仓库既有的「一次性播种」机制（console_seeds，见 lib/role-store.ts）。 */
export const IDENTITY_SEED = "identity_openid";

export type IdentityAuditAction = "link" | "unlink" | "login" | "merge";

export type IdentityAuditInput = {
  action: IdentityAuditAction;
  userId: string;
  provider?: string | null;
  providerUid?: string | null;
  ip?: string | null;
  ua?: string | null;
  /** 结果说明：ok / created / duplicate / backfill / 具体错误码。 */
  result: string;
};

export type UserRow = {
  id: string;
  status: "active" | "disabled" | "merged";
  canonical_email: string | null;
  merged_into: string | null;
  created_at: number;
  updated_at: number;
};

export type IdentityRow = {
  id: string;
  user_id: string;
  provider: string;
  provider_uid: string;
  provider_union_id: string | null;
  email: string | null;
  email_verified: boolean;
  created_at: number;
  last_login_at: number | null;
};

/** GitHub 侧的登录事实。userId 必须是 GitHub 的数字 id（`/user` 的 `id`）。 */
export type GithubIdentityInput = {
  login: string;
  userId: number | string;
  email?: string | null;
  emailVerified?: boolean;
};

export type BackfillReport = {
  skipped: boolean;
  users: number;
  identities: number;
  sessions: number;
  /** 会话里 user_id 为空的旧行：没有可用的渠道 id，无法回填，只统计不猜。 */
  unlinked: number;
};

export type CreateIdentityStoreOptions = { now?: () => number; random?: (size: number) => Buffer };

type IdentityRecord = {
  id: string; user_id: string; provider: string; provider_uid: string; provider_union_id: string | null;
  email: string | null; email_verified: number; created_at: number; last_login_at: number | null;
};

const toIdentity = (row: IdentityRecord): IdentityRow => ({
  id: row.id, user_id: row.user_id, provider: row.provider, provider_uid: row.provider_uid,
  provider_union_id: row.provider_union_id, email: row.email, email_verified: row.email_verified === 1,
  created_at: row.created_at, last_login_at: row.last_login_at,
});

export function createIdentityStore(db: Database.Database, options: CreateIdentityStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;

  function findIdentity(provider: string, providerUid: string): IdentityRow | null {
    const row = db.prepare("SELECT * FROM identities WHERE provider = ? AND provider_uid = ?").get(provider, providerUid) as IdentityRecord | undefined;
    return row ? toIdentity(row) : null;
  }

  function findUser(id: string): UserRow | null {
    return (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null;
  }

  function listIdentities(userId: string): IdentityRow[] {
    return (db.prepare("SELECT * FROM identities WHERE user_id = ? ORDER BY created_at ASC").all(userId) as IdentityRecord[]).map(toIdentity);
  }

  /** 这个用户还能用来登录的渠道数。解绑前必须 ≥1，否则会把账号锁死（P1 的解绑接口用）。 */
  function countLoginableIdentities(userId: string): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM identities WHERE user_id = ?").get(userId) as { n: number }).n;
  }

  function audit(input: IdentityAuditInput): void {
    db.prepare("INSERT INTO identity_audit(action, user_id, provider, provider_uid, ip, ua, ts, result) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.action, input.userId, input.provider ?? null, input.providerUid ?? null, input.ip ?? null, input.ua ?? null, now(), input.result);
  }

  /** 只建 users 行（分配内部 OpenID），不改身份来源；渠道凭据另写 identities。 */
  function insertUser(email: string | null): string {
    const openid = newOpenId(now(), random);
    const ts = now();
    db.prepare("INSERT INTO users(id, status, canonical_email, merged_into, created_at, updated_at) VALUES(?, 'active', ?, NULL, ?, ?)")
      .run(openid, email, ts, ts);
    return openid;
  }

  function insertIdentity(userId: string, provider: string, providerUid: string, email: string | null, emailVerified: boolean): string {
    const id = newOpenId(now(), random);
    db.prepare(
      "INSERT INTO identities(id, user_id, provider, provider_uid, provider_union_id, email, email_verified, raw, created_at, last_login_at) VALUES(?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)"
    ).run(id, userId, provider, providerUid, email, emailVerified ? 1 : 0, now(), now());
    return id;
  }

  /**
   * GitHub 登录：命中原身份就更新 last_login_at；没命中就新建 users（分配内部 OpenID）+ identities。
   * 新建与更新都在事务里，重复登录不会产生第二行身份。`raw` 不落库——不把第三方返回的个人信息存下来。
   */
  function resolveGithubIdentity(input: GithubIdentityInput): { openid: string; identityId: string; created: boolean } {
    const providerUid = String(input.userId);
    const existing = findIdentity(GITHUB_PROVIDER, providerUid);
    if (existing) {
      db.prepare("UPDATE identities SET last_login_at = ?, email = COALESCE(?, email), email_verified = ? WHERE id = ?")
        .run(now(), input.email ?? null, input.emailVerified ? 1 : 0, existing.id);
      return { openid: existing.user_id, identityId: existing.id, created: false };
    }
    return db.transaction(() => {
      const openid = insertUser(input.emailVerified ? (input.email ?? null) : null);
      const identityId = insertIdentity(openid, GITHUB_PROVIDER, providerUid, input.email ?? null, input.emailVerified ?? false);
      return { openid, identityId, created: true };
    })();
  }

  /**
   * 存量回填（#226）：老库里能定位到的身份只有会话行——`user_id` 是 GitHub 数字 id，`login` 是当时的登录名。
   * 为每个不同的 user_id 补一份 users + identities，并把已有会话的影子列补上；整个过程在一个事务里，
   * 最后写 `console_seeds` 标记，重复启动不会再做一遍。幂等、可从空库安全跑。
   */
  function backfillSessions(): BackfillReport {
    if (db.prepare("SELECT 1 FROM console_seeds WHERE name = ?").get(IDENTITY_SEED)) {
      return { skipped: true, users: 0, identities: 0, sessions: 0, unlinked: 0 };
    }
    return db.transaction(() => {
      const rows = db.prepare("SELECT DISTINCT user_id, login FROM sessions WHERE user_id IS NOT NULL").all() as { user_id: number; login: string }[];
      const unlinked = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id IS NULL").get() as { n: number }).n;
      let users = 0;
      let identities = 0;
      let sessions = 0;
      for (const row of rows) {
        const providerUid = String(row.user_id);
        const existing = findIdentity(GITHUB_PROVIDER, providerUid);
        let userId: string;
        if (existing) {
          userId = existing.user_id;
        } else {
          userId = insertUser(null);
          insertIdentity(userId, GITHUB_PROVIDER, providerUid, null, false);
          // 回填也是"把这份凭据挂到身份上"，用 link 记一条，result 标明来源是回填
          audit({ action: "link", userId, provider: GITHUB_PROVIDER, providerUid, result: "backfill" });
          users += 1;
          identities += 1;
        }
        sessions += db.prepare("UPDATE sessions SET openid = ?, provider = ? WHERE user_id = ? AND openid IS NULL").run(userId, GITHUB_PROVIDER, row.user_id).changes;
      }
      db.prepare("INSERT INTO console_seeds(name, seeded_at) VALUES(?, ?)").run(IDENTITY_SEED, now());
      return { skipped: false, users, identities, sessions, unlinked };
    })();
  }

  /**
   * 回滚（app/server/scripts/rollback-identity.mjs 用）：清掉影子列与播种标记、丢掉三张新表。
   * `sessions.openid` / `provider` 两列**不删**（SQLite 不支持 DROP COLUMN 的版本上会失败），只清空；
   * 旧列自始至终没动过，所以回滚后服务按旧逻辑照常跑，下次启动会重新建空表。
   */
  function rollback(): { dropped: string[]; sessionsCleared: number } {
    return db.transaction(() => {
      const sessionsCleared = db.prepare("UPDATE sessions SET openid = NULL, provider = NULL").run().changes;
      db.prepare("DELETE FROM console_seeds WHERE name = ?").run(IDENTITY_SEED);
      const dropped: string[] = [];
      for (const table of ["identity_audit", "identities", "users"]) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
        dropped.push(table);
      }
      return { dropped, sessionsCleared };
    })();
  }

  function listAudit(userId: string): { action: string; provider: string | null; provider_uid: string | null; result: string; ts: number }[] {
    return db.prepare("SELECT action, provider, provider_uid, result, ts FROM identity_audit WHERE user_id = ? ORDER BY id ASC").all(userId) as {
      action: string; provider: string | null; provider_uid: string | null; result: string; ts: number;
    }[];
  }

  return {
    findIdentity, findUser, listIdentities, countLoginableIdentities,
    resolveGithubIdentity, backfillSessions, audit, listAudit, rollback,
  };
}
