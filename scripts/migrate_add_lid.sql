-- Migration: adiciona coluna lid na tabela contacts
-- Executar uma única vez em bancos de dados já existentes.
-- Bancos criados a partir do create_database.sql já incluem a coluna.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lid VARCHAR(100) DEFAULT NULL
    COMMENT 'LID Baileys sem sufixo @lid (ex: 128904920580321)'
    AFTER phone_number;

-- Índice para lookup rápido LID → contato
CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts (lid);
