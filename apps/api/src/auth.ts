import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { pool } from "./db.js";
import { hashPassword, verifyPassword } from "./password.js";

const router = Router();
const cookieName = process.env.COOKIE_NAME || "yt_dashboard_session";
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(cookieName)) throw new Error("COOKIE_NAME contains invalid characters.");
const sessionLifetimeSeconds = 7 * 24 * 60 * 60;
const secureCookie = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";

type LoginAttempt = { count: number; resetAt: number };
const loginAttempts = new Map<string, LoginAttempt>();

function tokenFromRequest(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const [name, ...valueParts] = entry.trim().split("=");
    if (name === cookieName) {
      try { return decodeURIComponent(valueParts.join("=")); } catch { return undefined; }
    }
  }
  return undefined;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(res: Response, token: string): void {
  const secure = secureCookie ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${cookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Priority=High; Max-Age=${sessionLifetimeSeconds}${secure}`,
  );
}

function clearSessionCookie(res: Response): void {
  const secure = secureCookie ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${cookieName}=; HttpOnly; Path=/; SameSite=Lax; Priority=High; Max-Age=0${secure}`);
}

function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  for (const [ip, attempt] of loginAttempts) {
    if (attempt.resetAt <= now) loginAttempts.delete(ip);
  }
  const key = req.ip || "unknown";
  if (!loginAttempts.has(key) && loginAttempts.size >= 10_000) {
    const oldest = loginAttempts.keys().next().value;
    if (oldest) loginAttempts.delete(oldest);
  }
  const attempt = loginAttempts.get(key);
  if (attempt && attempt.count >= 8) {
    res.status(429).json({ error: "Too many login attempts. Try again later." });
    return;
  }
  next();
}

function recordFailedLogin(req: Request): void {
  const key = req.ip || "unknown";
  if (!loginAttempts.has(key) && loginAttempts.size >= 10_000) {
    const oldest = loginAttempts.keys().next().value;
    if (oldest) loginAttempts.delete(oldest);
  }
  const previous = loginAttempts.get(key);
  loginAttempts.set(key, {
    count: (previous?.count ?? 0) + 1,
    resetAt: previous?.resetAt ?? Date.now() + 15 * 60 * 1000,
  });
}

export async function requireAuthenticated(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = tokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  try {
    const result = await pool.query<{ admin_id: string; role: "admin" | "viewer" }>(
      `SELECT u.admin_id, u.role
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [tokenHash(token)],
    );
    if (!result.rowCount) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Your session has expired. Sign in again." });
      return;
    }
    res.locals.adminId = result.rows[0].admin_id;
    res.locals.role = result.rows[0].role;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  void requireAuthenticated(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    if (res.headersSent) return;
    if (res.locals.role !== "admin") {
      res.status(403).json({ error: "Administrator access is required for this action." });
      return;
    }
    next();
  });
}

router.post("/login", loginRateLimit, async (req, res, next) => {
  try {
    const adminId = typeof req.body?.adminId === "string" ? req.body.adminId.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (adminId.length > 80 || password.length > 1024) {
      recordFailedLogin(req);
      res.status(401).json({ error: "The admin ID or password is incorrect." });
      return;
    }
    const result = await pool.query<{ id: string; admin_id: string; password_hash: string; role: "admin" | "viewer" }>(
      "SELECT id, admin_id, password_hash, role FROM admin_users WHERE admin_id = $1",
      [adminId],
    );
    const admin = result.rows[0];
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      recordFailedLogin(req);
      res.status(401).json({ error: "The admin ID or password is incorrect." });
      return;
    }

    loginAttempts.delete(req.ip || "unknown");
    const token = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO admin_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [tokenHash(token), admin.id],
    );
    setSessionCookie(res, token);
    res.json({ adminId: admin.admin_id, role: admin.role });
  } catch (error) {
    next(error);
  }
});

router.get("/me", requireAuthenticated, (_req, res) => {
  res.json({ adminId: res.locals.adminId, role: res.locals.role });
});

router.get("/users", requireAdmin, async (_req, res, next) => {
  try {
    const users = await pool.query("SELECT id, admin_id AS \"adminId\", role FROM admin_users ORDER BY id");
    res.json({ users: users.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/users", requireAdmin, async (req, res, next) => {
  try {
    const adminId = typeof req.body?.adminId === "string" ? req.body.adminId.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const role = req.body?.role;
    if (!/^[a-zA-Z0-9_.-]{2,80}$/.test(adminId) || adminId.toLocaleLowerCase() === "admin") {
      res.status(400).json({ error: "Choose a non-default admin ID using 2–80 letters, numbers, dots, underscores, or hyphens." });
      return;
    }
    if (password.length < 12 || password.length > 1024) {
      res.status(400).json({ error: "New user passwords must be at least 12 characters." });
      return;
    }
    if (role !== "admin" && role !== "viewer") {
      res.status(400).json({ error: "Choose either the admin or viewer role." });
      return;
    }
    const created = await pool.query<{ id: string; admin_id: string; role: string }>(
      `INSERT INTO admin_users (admin_id, password_hash, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (admin_id) DO NOTHING
       RETURNING id, admin_id, role`,
      [adminId, hashPassword(password), role],
    );
    if (!created.rowCount) {
      res.status(409).json({ error: "That admin ID is already in use." });
      return;
    }
    res.status(201).json({ user: { id: created.rows[0].id, adminId: created.rows[0].admin_id, role: created.rows[0].role } });
  } catch (error) {
    next(error);
  }
});

router.patch("/users/:id/role", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = req.params.id;
    const role = req.body?.role;
    if (typeof userId !== "string" || !/^\d+$/.test(userId) || (role !== "admin" && role !== "viewer")) {
      res.status(400).json({ error: "Choose a valid user and either the admin or viewer role." });
      return;
    }
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(74281019)");
    const target = await client.query<{ admin_id: string; role: string }>(
      "SELECT admin_id, role FROM admin_users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    if (!target.rowCount) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Admin user not found." });
      return;
    }
    const currentUserId = await pool.query<{ id: string }>(
      `SELECT u.id::text AS id FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() LIMIT 1`,
      [tokenHash(tokenFromRequest(req) || "")],
    );
    if (role === "viewer" && currentUserId.rows[0]?.id === userId) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "You cannot remove your own administrator access." });
      return;
    }
    if (target.rows[0].role === "admin" && role === "viewer") {
      const admins = await client.query("SELECT COUNT(*)::int AS count FROM admin_users WHERE role = 'admin'");
      if (Number(admins.rows[0]?.count) <= 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "The workspace must keep at least one administrator." });
        return;
      }
    }
    await client.query("UPDATE admin_users SET role = $2 WHERE id = $1", [userId, role]);
    await client.query("DELETE FROM admin_sessions WHERE user_id = $1", [userId]);
    await client.query("COMMIT");
    res.json({ user: { id: userId, adminId: target.rows[0].admin_id, role } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    if (token) await pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [tokenHash(token)]);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
