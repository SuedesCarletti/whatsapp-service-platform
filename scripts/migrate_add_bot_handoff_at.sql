-- Migration: adiciona coluna bot_handoff_at na tabela conversations — momento
-- exato em que um atendente humano assumiu uma conversa que o bot/IA estava
-- respondendo (bot_enabled True → False por handle_agent_outbound_reply ou
-- pelo toggle manual em PATCH /conversations/{id}/bot). Permite medir
-- "quanto tempo o bot cuidou até um humano assumir" — diferente de
-- assigned_at, que pode já ter sido setado antes por atribuição manual
-- enquanto o bot ainda respondia sozinho.
-- Executar uma única vez em bancos de dados já existentes.

ALTER TABLE conversations
  ADD COLUMN bot_handoff_at DATETIME DEFAULT NULL
    COMMENT 'Momento em que um atendente assumiu a conversa que o bot estava respondendo'
    AFTER bot_enabled;
