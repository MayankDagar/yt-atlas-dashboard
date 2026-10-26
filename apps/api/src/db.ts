import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { hashPassword } from "./password.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

export const pool = new Pool({
  connectionString: databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});

export async function initializeDatabase(): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = resolve(currentDir, "../migrations");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       migration_name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );
  const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const migrationName of migrations) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE migration_name = $1", [migrationName]);
    if (applied.rowCount) continue;
    const sql = await readFile(resolve(migrationsDir, migrationName), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (migration_name) VALUES ($1)", [migrationName]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const adminId = process.env.ADMIN_ID?.trim();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminId || !adminPassword || adminPassword.startsWith("change-this")) {
    throw new Error("Set ADMIN_ID and a unique, non-empty ADMIN_PASSWORD in .env");
  }
  const configuredAdmin = await pool.query("SELECT 1 FROM admin_users WHERE admin_id = $1", [adminId]);
  if (!configuredAdmin.rowCount) {
    if (adminId.toLocaleLowerCase() === "admin") {
      throw new Error("Choose a non-default ADMIN_ID before creating the first admin account.");
    }
    if (adminPassword.length < 12) {
      throw new Error("The initial admin password must be at least 12 characters long.");
    }
    await pool.query(
      `INSERT INTO admin_users (admin_id, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (admin_id) DO NOTHING`,
      [adminId, hashPassword(adminPassword)],
    );
  }

  // Require admins to sign in again whenever the API server starts.
  await pool.query("DELETE FROM admin_sessions");
  // YouTube's policy limits retention of non-authorized API data. Owner-authorized
  // Analytics data will use a separate retention policy when that integration is added.
  await pool.query("DELETE FROM metric_snapshots WHERE expires_at <= NOW()");
  await pool.query("DELETE FROM video_engagement_snapshots WHERE expires_at <= NOW()");
  await pool.query(
    `UPDATE channels SET youtube_title = NULL, description = NULL, channel_published_at = NULL,
       subscriber_count = NULL, subscribers_hidden = FALSE, youtube_video_count = NULL, profile_observed_at = NULL,
       contact_details = '{"emails": [], "phones": [], "socialLinks": [], "websites": []}'::jsonb
     WHERE profile_observed_at <= NOW() - INTERVAL '30 days'`,
  );
}
