CREATE TABLE IF NOT EXISTS tenant_bootstrap_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  file_name VARCHAR(64) NOT NULL COMMENT 'SOUL.md, AGENTS.md, etc.',
  content MEDIUMTEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_file (tenant_id, file_name),
  KEY idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
