-- Migration: fixar mensagem (WhatsApp + Equipe) e encaminhamento cruzado
-- WhatsApp <-> Equipe (referência ao contato de origem). Executar uma vez.

ALTER TABLE messages
  ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER is_starred;

ALTER TABLE internal_messages
  ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER is_starred,
  ADD COLUMN forwarded_from_wa_conversation_id INT NULL,
  ADD COLUMN forwarded_from_wa_wamid VARCHAR(255) NULL,
  ADD COLUMN forwarded_from_contact_name VARCHAR(255) NULL,
  ADD COLUMN forwarded_from_contact_phone VARCHAR(50) NULL,
  ADD CONSTRAINT fk_internal_messages_wa_conversation
    FOREIGN KEY (forwarded_from_wa_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
