-- Migration: nova permissão feature_attendance_agent (marca quais papéis
-- participam da mecânica de atendimento — dropdown de atribuição e SLA).
-- Executar uma única vez em bancos de dados já existentes.
-- Instalações novas já ganham isso via backend/database/seed.py.
--
-- Sem essa migração, os papéis admin/supervisor/attendant já cadastrados
-- ficariam sem a chave (equivale a False) e sumiriam do pool de atribuição
-- depois do deploy. Papéis customizados (Vendedor, Usuário simples etc.)
-- continuam sem a chave de propósito — nascem fora da mecânica de
-- atendimento até o admin marcar a permissão explicitamente em Papéis.

UPDATE roles
SET permissions = JSON_SET(permissions, '$.feature_attendance_agent', true)
WHERE `key` IN ('admin', 'supervisor', 'attendant');
