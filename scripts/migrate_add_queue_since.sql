-- Migration: adiciona coluna queue_since na tabela conversations — início do
-- cronômetro "⏳ esperando" do Sidebar (Sidebar.js::getSlaBadge) quando a
-- conversa VOLTA a ficar sem responsável depois de já ter sido trabalhada
-- (reabertura sem responsável em webhook_handler.py, ou liberação manual em
-- routes_attendance.py assign_conversation). NULL = usa created_at (mesmo
-- comportamento de sempre, conversa nunca saiu da fila desde que nasceu).
-- Executar uma única vez em bancos de dados já existentes.

ALTER TABLE conversations
  ADD COLUMN queue_since DATETIME DEFAULT NULL
    COMMENT 'Início do tempo de espera na fila desde a última vez que ficou sem responsável — NULL usa created_at'
    AFTER last_business_hours_autoreply_at;
