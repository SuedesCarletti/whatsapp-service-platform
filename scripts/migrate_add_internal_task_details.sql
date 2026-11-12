-- Migration: subtasks e anexos pra tarefas do chat interno (internal_tasks).
-- Executar uma única vez em bancos de dados já existentes.

CREATE TABLE IF NOT EXISTS internal_task_subtasks (
  id INT NOT NULL AUTO_INCREMENT,
  task_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  is_done TINYINT(1) NOT NULL DEFAULT 0,
  position INT NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY ix_internal_task_subtasks_task_id (task_id),
  CONSTRAINT fk_internal_task_subtasks_task FOREIGN KEY (task_id) REFERENCES internal_tasks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS internal_task_attachments (
  id INT NOT NULL AUTO_INCREMENT,
  task_id INT NOT NULL,
  uploaded_by INT DEFAULT NULL,
  file_url TEXT NOT NULL,
  filename VARCHAR(255) DEFAULT NULL,
  mime_type VARCHAR(100) DEFAULT NULL,
  created_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY ix_internal_task_attachments_task_id (task_id),
  KEY fk_internal_task_attachments_uploaded_by (uploaded_by),
  CONSTRAINT fk_internal_task_attachments_task FOREIGN KEY (task_id) REFERENCES internal_tasks (id) ON DELETE CASCADE,
  CONSTRAINT fk_internal_task_attachments_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
