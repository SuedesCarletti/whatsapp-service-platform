-- Migration: nova permissão `feature_view_shared_account_chats` — dedicada
-- pra atendentes que dividem uma conta WhatsApp com colega poderem ver a
-- conversa um do outro, SEM precisar da permissão mais ampla
-- feature_view_all_chats (que soa/se comporta como "ver tudo em qualquer
-- conta" quando combinada com feature_view_all_accounts=True).
-- Fica decoupled de propósito: dá pra desligar só esta no futuro (ex:
-- quando existir fila de atendimento de verdade) sem mexer em
-- feature_view_all_chats, que continua servindo outro propósito (supervisor
-- ver tudo mesmo). Ver backend/api/routes.py get_conversations.
-- Executar uma única vez em bancos já existentes — instalações novas já
-- ganham isso via backend/database/seed.py.

UPDATE roles
SET permissions = JSON_SET(permissions, '$.feature_view_shared_account_chats', true)
WHERE `key` IN ('admin', 'supervisor');

-- Papel "attendant": a permissão nova assume o papel que feature_view_all_chats
-- estava cumprindo temporariamente (ver 2026-09-04 mais cedo) — volta
-- feature_view_all_chats pro default (False) e liga a permissão certa/
-- específica no lugar. Efeito prático pro usuário final é o mesmo (com
-- feature_view_all_accounts=False já configurado, ver commit anterior),
-- só muda qual chave está controlando.
UPDATE roles
SET permissions = JSON_SET(
    permissions,
    '$.feature_view_shared_account_chats', true,
    '$.feature_view_all_chats', false
)
WHERE `key` = 'attendant';

-- Demais papéis (custom, ex: "logistica"): False explícito — fail-closed,
-- o admin liga se fizer sentido pra esse papel em Papéis.
UPDATE roles
SET permissions = JSON_SET(permissions, '$.feature_view_shared_account_chats', false)
WHERE `key` NOT IN ('admin', 'supervisor', 'attendant');
