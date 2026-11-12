-- Migration: adiciona coluna is_internal na tabela contacts — marca contatos
-- internos (colegas/fornecedores falando pelo número da empresa) que não
-- devem receber bot/IA, aviso de fora-do-horário, nem entrar no cálculo de
-- SLA/CSAT de atendimento (ver ContactInfoPanel.js e webhook_handler.py).
-- Executar uma única vez em bancos de dados já existentes.
-- Bancos criados a partir do create_database.sql já incluem a coluna.

ALTER TABLE contacts
  ADD COLUMN is_internal TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Contato interno (colega/fornecedor) — sem bot/IA, sem SLA/CSAT/fora-do-horário'
    AFTER group_subject;
