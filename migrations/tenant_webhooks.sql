CREATE TABLE IF NOT EXISTS tenant_webhooks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  webhook_id VARCHAR(64) NOT NULL,
  callback_url VARCHAR(2048) NOT NULL,
  signing_secret VARCHAR(128) NOT NULL COMMENT 'HMAC signing secret (whsec_ prefix)',
  agent_id VARCHAR(64) NOT NULL DEFAULT 'main',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_webhook_id (webhook_id),
  KEY idx_tenant (tenant_id),
  KEY idx_tenant_enabled (tenant_id, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
