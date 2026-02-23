CREATE TABLE IF NOT EXISTS tenant_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_path VARCHAR(255) NOT NULL,
  session_key VARCHAR(255) NOT NULL,
  session_data JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_session (store_path, session_key),
  KEY idx_store_path (store_path),
  KEY idx_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
