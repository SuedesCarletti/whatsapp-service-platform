-- Migration: rastrear PERMANENTEMENTE se uma conversa já foi respondida por
-- um humano alguma vez. Conversation.bot_handoff_at não serve pra isso — é
-- zerado de propósito ao marcar Resolvida (pra religar o bot numa eventual
-- reabertura), então na hora de ler pra relatório já está sempre NULL,
-- respondida por humano ou não. Este campo nunca é apagado.
-- Executar uma vez.

ALTER TABLE conversations
  ADD COLUMN ever_handled_by_human BOOLEAN NOT NULL DEFAULT FALSE AFTER bot_handoff_at;
