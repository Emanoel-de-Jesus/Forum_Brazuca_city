-- Estrutura opcional para dados próprios do fórum.
-- As contas/personagens continuam sendo puxados da tabela real da Gamemode/API.
CREATE TABLE IF NOT EXISTS forum_topics (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  display_id BIGINT UNSIGNED NULL,
  subforum_id VARCHAR(64) NOT NULL,
  title VARCHAR(180) NOT NULL,
  author_username VARCHAR(64) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  locked TINYINT(1) NOT NULL DEFAULT 0,
  views BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_forum_topics_subforum (subforum_id),
  INDEX idx_forum_topics_author (author_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS forum_replies (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  topic_id BIGINT UNSIGNED NOT NULL,
  author_username VARCHAR(64) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_forum_replies_topic (topic_id),
  CONSTRAINT fk_forum_replies_topic FOREIGN KEY (topic_id) REFERENCES forum_topics(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS forum_audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_player_id INT NULL,
  actor_username VARCHAR(64) NULL,
  action VARCHAR(120) NOT NULL,
  meta_json LONGTEXT NULL,
  metadata JSON NULL,
  ip VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_forum_audit_player (actor_player_id),
  INDEX idx_forum_audit_actor (actor_username),
  INDEX idx_forum_audit_action (action),
  INDEX idx_forum_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS forum_state_snapshots (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  state_json LONGTEXT NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_by VARCHAR(64) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Verificacao de e-mail da WL (codigo armazenado apenas como SHA-256)
CREATE TABLE IF NOT EXISTS forum_email_verifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  player_id INT NOT NULL,
  username VARCHAR(32) NOT NULL,
  email VARCHAR(160) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  request_ip VARCHAR(64) NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_forum_verify_player (player_id),
  INDEX idx_forum_verify_email (email),
  INDEX idx_forum_verify_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
