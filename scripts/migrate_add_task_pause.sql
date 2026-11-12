-- Migration: pausar tarefa interna com justificativa obrigatória. status
-- ganha um 3º valor "paused" (além de pending|done); internal_tasks guarda
-- quem pausou/quando/por quê (estado "ativo" da pausa atual — retomar limpa
-- esses 3 campos); internal_task_history ganha uma coluna de justificativa
-- de texto livre pra preservar o motivo permanentemente na trilha de
-- auditoria, mesmo depois da tarefa ser retomada.
-- Executar uma vez.

ALTER TABLE internal_tasks
  ADD COLUMN paused_by INT NULL AFTER approved_at,
  ADD COLUMN paused_at DATETIME NULL AFTER paused_by,
  ADD COLUMN pause_reason TEXT NULL AFTER paused_at,
  ADD CONSTRAINT fk_internal_tasks_paused_by FOREIGN KEY (paused_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE internal_task_history
  ADD COLUMN reason TEXT NULL AFTER event;
