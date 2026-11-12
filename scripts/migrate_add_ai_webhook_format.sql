-- Migration: modo de payload do webhook de IA por conta — "generic" (contrato
-- próprio, ver POST /api/bot/reply) ou "evolution_compat" (imita o contrato da
-- Evolution API, usado pra migrar bots n8n baseados na Evolution API sem reescrever
-- seus nós de envio — ver backend/api/routes_evolution_compat.py).
-- Executar uma única vez. Nota: "ADD COLUMN IF NOT EXISTS" não é aceito nesta
-- instância de MySQL (8.0.46) — rodar só uma vez.

ALTER TABLE whatsapp_accounts
  ADD COLUMN ai_webhook_format VARCHAR(20) NOT NULL DEFAULT 'generic'
    COMMENT 'generic | evolution_compat — formato do payload de saída em _forward_to_ai_webhook';
