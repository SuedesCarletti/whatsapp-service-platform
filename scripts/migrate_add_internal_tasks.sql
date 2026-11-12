-- Migration: tarefas dentro do chat interno (DM/grupo da equipe).
-- Executar uma única vez em bancos de dados já existentes.

CREATE TABLE IF NOT EXISTS internal_tasks (
  id INT NOT NULL AUTO_INCREMENT,
  conversation_id INT NOT NULL,
  created_by INT DEFAULT NULL,
  assigned_to INT DEFAULT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT DEFAULT NULL,
  due_at DATETIME DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  completed_by INT DEFAULT NULL,
  completed_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY ix_internal_tasks_conversation_id (conversation_id),
  KEY fk_internal_tasks_assigned_to (assigned_to),
  KEY fk_internal_tasks_created_by (created_by),
  KEY fk_internal_tasks_completed_by (completed_by),
  CONSTRAINT fk_internal_tasks_conversation FOREIGN KEY (conversation_id) REFERENCES internal_conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_internal_tasks_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_internal_tasks_assigned_to FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_internal_tasks_completed_by FOREIGN KEY (completed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE internal_messages
  ADD COLUMN task_id INT DEFAULT NULL AFTER forwarded_from_contact_phone,
  ADD KEY fk_internal_messages_task (task_id),
  ADD CONSTRAINT fk_internal_messages_task FOREIGN KEY (task_id) REFERENCES internal_tasks (id) ON DELETE SET NULL;
