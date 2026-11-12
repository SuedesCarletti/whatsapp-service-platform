-- Migration: urgência da tarefa (baixa/média/alta/urgente). Toda tarefa já
-- existente vira "medium" (era o nível implícito antes da urgência existir),
-- e é o que uma tarefa nova assume se ninguém escolher outro.
-- Executar uma vez.

ALTER TABLE internal_tasks
  ADD COLUMN priority VARCHAR(10) NOT NULL DEFAULT 'medium' AFTER status;
