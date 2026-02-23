import mysql from "mysql2/promise";

export type DbPoolConfig = {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
};

export function createDbPool(config: DbPoolConfig): mysql.Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port ?? 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit ?? 10,
    waitForConnections: true,
  });
}
