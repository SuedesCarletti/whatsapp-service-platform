-- Migration: novas permissões por TELA — App Meta, Flows, Catálogo (agora
-- separado de Templates), Qualidade do Número, e as 5 abas do Painel Admin
-- (Dashboard/Contas/Papéis/Aprovações/Config do Sistema, que antes eram
-- tudo-ou-nada via is_admin). Executar uma única vez em bancos já existentes
-- — instalações novas já ganham isso via backend/database/seed.py.
--
-- Sem essa migração, os papéis admin/supervisor/attendant já cadastrados
-- ficariam sem essas chaves (equivale a False) e as telas correspondentes
-- sumiriam do menu pra todo mundo — inclusive pro papel "admin", que sem
-- is_admin=True em algum usuário ficaria sem enxergar o próprio Painel
-- Admin. Papéis customizados (Vendedor, Financeiro etc.) continuam sem as
-- chaves novas até o admin marcar explicitamente em Papéis (comportamento
-- fail-closed esperado — tela nova não aparece por padrão pra papel
-- customizado nenhum).

UPDATE roles
SET permissions = JSON_SET(
    permissions,
    '$.settings_meta_app',      true,
    '$.settings_flows',         true,
    '$.settings_catalog',       true,
    '$.settings_phone_quality', true,
    '$.admin_dashboard',        true,
    '$.admin_accounts',         true,
    '$.admin_roles',            true,
    '$.admin_approvals',        true,
    '$.admin_system_config',    true
)
WHERE `key` = 'admin';

UPDATE roles
SET permissions = JSON_SET(
    permissions,
    '$.settings_meta_app',      false,
    '$.settings_flows',         false,
    '$.settings_catalog',       false,
    '$.settings_phone_quality', true,
    '$.admin_dashboard',        true,
    '$.admin_accounts',         false,
    '$.admin_roles',            false,
    '$.admin_approvals',        true,
    '$.admin_system_config',    false
)
WHERE `key` = 'supervisor';

UPDATE roles
SET permissions = JSON_SET(
    permissions,
    '$.settings_meta_app',      false,
    '$.settings_flows',         false,
    '$.settings_catalog',       false,
    '$.settings_phone_quality', false,
    '$.admin_dashboard',        false,
    '$.admin_accounts',         false,
    '$.admin_roles',            false,
    '$.admin_approvals',        false,
    '$.admin_system_config',    false
)
WHERE `key` = 'attendant';

-- Papéis customizados (fora dos 3 builtin, ex: "Logística") recebem tudo
-- False explícito — fail-closed, o admin liga o que fizer sentido depois em
-- Papéis. São chaves NOVAS (não existiam antes desta migração em papel
-- nenhum), por isso dá pra sobrescrever direto com JSON_SET, sem se
-- preocupar em preservar valor anterior.
UPDATE roles
SET permissions = JSON_SET(
    permissions,
    '$.settings_meta_app',      false,
    '$.settings_flows',         false,
    '$.settings_catalog',       false,
    '$.settings_phone_quality', false,
    '$.admin_dashboard',        false,
    '$.admin_accounts',         false,
    '$.admin_roles',            false,
    '$.admin_approvals',        false,
    '$.admin_system_config',    false
)
WHERE `key` NOT IN ('admin', 'supervisor', 'attendant');
