-- Entity Memory tables (OpenClaw platform primitive)
-- Three tables for structured persistent memory: profiles, episodes, concerns.

CREATE TABLE IF NOT EXISTS oc_memory_profiles (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       VARCHAR(128) NOT NULL,
  profile_data    JSON NOT NULL,
  version         INT UNSIGNED NOT NULL DEFAULT 1,
  last_interaction_at TIMESTAMP NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS oc_memory_episodes (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       VARCHAR(128) NOT NULL,
  episode_type    VARCHAR(64) NOT NULL,
  channel         VARCHAR(32) NOT NULL DEFAULT 'system',
  content         TEXT NOT NULL,
  metadata        JSON DEFAULT NULL,
  is_superseded   TINYINT(1) NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant_date (tenant_id, created_at DESC),
  INDEX idx_tenant_type (tenant_id, episode_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS oc_memory_concerns (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       VARCHAR(128) NOT NULL,
  concern_key     VARCHAR(100) NOT NULL,
  display_name    VARCHAR(200) NOT NULL,
  severity        ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  status          ENUM('active','improving','resolved','escalated') NOT NULL DEFAULT 'active',
  mention_count   INT UNSIGNED NOT NULL DEFAULT 1,
  evidence        JSON NOT NULL,
  first_seen_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at     TIMESTAMP NULL,
  followup_due    DATE DEFAULT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_concern (tenant_id, concern_key),
  INDEX idx_tenant_active (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
