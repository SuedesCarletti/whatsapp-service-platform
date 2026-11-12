-- Migration: favoritar/silenciar conversa (clientes global, equipe por
-- participante) + foto de perfil do usuário no chat interno. Executar uma vez.

ALTER TABLE users
  ADD COLUMN photo_url TEXT NULL AFTER display_name_format;

ALTER TABLE conversations
  ADD COLUMN is_favorite TINYINT(1) NOT NULL DEFAULT 0 AFTER is_pinned,
  ADD COLUMN is_muted TINYINT(1) NOT NULL DEFAULT 0 AFTER is_favorite;

ALTER TABLE internal_conversation_participants
  ADD COLUMN is_muted TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN is_favorite TINYINT(1) NOT NULL DEFAULT 0;
