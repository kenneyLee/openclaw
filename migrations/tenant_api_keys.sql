CREATE TABLE IF NOT EXISTS tenant_api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  api_key_hash VARCHAR(64) NOT NULL COMMENT 'SHA-256 hash',
  tenant_id VARCHAR(64) NOT NULL,
  label VARCHAR(128) DEFAULT NULL,
  scopes JSON DEFAULT NULL COMMENT 'null = all scopes',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_api_key_hash (api_key_hash),
  KEY idx_tenant (tenant_id),
  KEY idx_enabled_expires (enabled, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
