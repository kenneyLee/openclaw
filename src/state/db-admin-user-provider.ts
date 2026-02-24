/**
 * Database Admin User Provider
 *
 * CRUD for the admin_users table.  Passwords are hashed with scrypt
 * (memory-hard KDF) via `node:crypto` — no external dependencies.
 *
 * Follows the same pattern as db-tenant-provider.ts.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Pool, RowDataPacket } from "mysql2/promise";

const scryptAsync = promisify(scrypt);

// ── Password hashing ─────────────────────────────────────────────────

const SALT_BYTES = 32;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [saltHex, derivedHex] = hash.split(":");
  if (!saltHex || !derivedHex) {
    return false;
  }
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(derivedHex, "hex");
  const actual = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

// ── Entity ───────────────────────────────────────────────────────────

export interface AdminUser {
  id: number;
  username: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AdminUserRow extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function rowToEntity(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    username: row.username,
    isActive: row.is_active === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ── Provider ─────────────────────────────────────────────────────────

export class DatabaseAdminUserProvider {
  constructor(private readonly pool: Pool) {}

  async getByUsername(username: string): Promise<(AdminUser & { passwordHash: string }) | null> {
    const [rows] = await this.pool.execute<AdminUserRow[]>(
      "SELECT id, username, password_hash, is_active, created_at, updated_at FROM admin_users WHERE username = ?",
      [username],
    );
    if (rows.length === 0) {
      return null;
    }
    return { ...rowToEntity(rows[0]), passwordHash: rows[0].password_hash };
  }

  async getById(id: number): Promise<AdminUser | null> {
    const [rows] = await this.pool.execute<AdminUserRow[]>(
      "SELECT id, username, password_hash, is_active, created_at, updated_at FROM admin_users WHERE id = ?",
      [id],
    );
    if (rows.length === 0) {
      return null;
    }
    return rowToEntity(rows[0]);
  }

  async create(username: string, password: string): Promise<AdminUser> {
    const hash = await hashPassword(password);
    await this.pool.execute("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)", [
      username,
      hash,
    ]);
    const user = await this.getByUsername(username);
    return user!;
  }
}
