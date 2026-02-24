/**
 * Seed Admin User
 *
 * Usage:
 *   node --import tsx scripts/seed-admin-user.ts --username admin --password <password>
 *
 * Environment variables for DB connection:
 *   DB_HOST     (default: 127.0.0.1)
 *   DB_PORT     (default: 3306)
 *   DB_USER     (required)
 *   DB_PASSWORD  (required)
 *   DB_NAME     (required)
 */

import { parseArgs } from "node:util";
import mysql from "mysql2/promise";
import { hashPassword } from "../src/state/db-admin-user-provider.js";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS admin_users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`;

async function main() {
  const { values } = parseArgs({
    options: {
      username: { type: "string" },
      password: { type: "string" },
    },
    strict: true,
  });

  if (!values.username || !values.password) {
    console.error("Usage: seed-admin-user.ts --username <name> --password <password>");
    process.exit(1);
  }

  const host = process.env.DB_HOST || "127.0.0.1";
  const port = Number(process.env.DB_PORT || "3306");
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;

  if (!user || !password || !database) {
    console.error("Missing required env vars: DB_USER, DB_PASSWORD, DB_NAME");
    process.exit(1);
  }

  const pool = mysql.createPool({ host, port, user, password, database, connectionLimit: 1 });

  try {
    // Ensure table exists
    await pool.execute(CREATE_TABLE_SQL);
    console.log("admin_users table ready.");

    // Check if username already exists
    const [existing] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM admin_users WHERE username = ?",
      [values.username],
    );
    if (existing.length > 0) {
      console.error(`User "${values.username}" already exists (id=${existing[0].id}).`);
      process.exit(1);
    }

    // Create user
    const hash = await hashPassword(values.password);
    await pool.execute("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)", [
      values.username,
      hash,
    ]);
    console.log(`Admin user "${values.username}" created successfully.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
