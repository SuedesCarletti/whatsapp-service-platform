-- Migration: fixar CONVERSA (WhatsApp + Equipe), distinto do pin de MENSAGEM
-- que já existe (ver migrate_add_pin_and_cross_forward.sql). Antes disso,
-- "Fixar Conversa" só chamava o pin nativo do protocolo WhatsApp (limitado a
-- 3 chats, sem efeito nenhum em conversa interna/grupo) e nunca persistia no
-- nosso banco — a Sidebar nunca soube reordenar nem mostrar o estado.
-- Executar uma vez.

ALTER TABLE conversations
  ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER is_archived;

ALTER TABLE internal_conversations
  ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0;
