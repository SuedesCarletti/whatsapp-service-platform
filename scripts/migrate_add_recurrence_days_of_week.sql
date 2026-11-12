-- Migration: nova coluna recurrence_days_of_week em internal_tasks — permite
-- recorrência semanal marcando dias específicos (ex: toda segunda e
-- quinta) em vez de só "a cada N semanas" a partir da data de criação.
-- Lista JSON de inteiros, 0=segunda...6=domingo (convenção de
-- datetime.weekday() do Python). NULL/vazio = comportamento antigo
-- (mesmo dia da âncora, a cada N semanas) — nenhuma tarefa existente
-- muda de comportamento.
-- Executar uma única vez em bancos já existentes. Instalações novas
-- ganham a coluna automaticamente via SQLAlchemy create_all
-- (backend/database/models.py InternalTask).

ALTER TABLE internal_tasks
  ADD COLUMN recurrence_days_of_week JSON NULL AFTER recurrence_every;
