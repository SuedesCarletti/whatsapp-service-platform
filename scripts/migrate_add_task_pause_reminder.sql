-- Migration: lembrete opcional pra tarefa pausada, pra não cair no
-- esquecimento. pause_reminder_at é o horário escolhido por quem pausou;
-- pause_reminder_notified_at fica NULL até o watchdog disparar o aviso
-- (evita repetir a cada ciclo). Retomar a tarefa limpa os dois.
-- Executar uma vez.

ALTER TABLE internal_tasks
  ADD COLUMN pause_reminder_at DATETIME NULL AFTER pause_reason,
  ADD COLUMN pause_reminder_notified_at DATETIME NULL AFTER pause_reminder_at;
