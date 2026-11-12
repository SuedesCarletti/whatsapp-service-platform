-- Migration: integração genérica de bot/IA (n8n ou qualquer ferramenta via
-- POST /api/bot/reply) + handoff humano automático.
-- Executar uma única vez em bancos de dados já existentes.
-- Bancos criados a partir do create_database.sql já incluem as colunas.

-- Nota: "ADD COLUMN IF NOT EXISTS" não é aceito nesta instância de MySQL
-- (8.0.46) apesar de nominalmente suportado desde 8.0.29 — usar ALTER TABLE
-- simples; rodar só uma vez (dá erro 1060 "Duplicate column" se repetir).

ALTER TABLE conversations
  ADD COLUMN bot_enabled TINYINT(1) NOT NULL DEFAULT 1
    COMMENT 'Se a conversa deve ser encaminhada pro webhook de IA da conta (pausa quando um atendente humano assume)'
    AFTER last_business_hours_autoreply_at;

ALTER TABLE whatsapp_accounts
  ADD COLUMN ai_webhook_enabled TINYINT(1) DEFAULT 0
    COMMENT 'Encaminha mensagens recebidas pra ai_webhook_url (n8n ou outra ferramenta)',
  ADD COLUMN ai_webhook_url VARCHAR(500) DEFAULT NULL,
  ADD COLUMN ai_webhook_secret VARCHAR(255) DEFAULT NULL
    COMMENT 'Bearer token: usado tanto pro wpp autenticar o POST de saída quanto pra validar POST /api/bot/reply de entrada';
