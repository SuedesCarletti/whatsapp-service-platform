-- Migration: nova coluna display_name_format em users — preferência de como
-- o nome da pessoa aparece pro cliente (prefixo de identidade nas mensagens
-- de texto) e pra equipe (nome do remetente no chat interno).
-- "first_initial" = "João S." (primeiro nome + inicial do sobrenome),
-- "initial_last" = "J. Silva" (inicial + sobrenome).
-- Default 'first_initial' pra TODO MUNDO (inclusive contas já existentes —
-- decisão confirmada com o usuário: muda a aparência de quem não escolher
-- nada, de propósito, não é só "preserva o comportamento antigo").
-- Executar uma única vez em bancos já existentes. Instalações novas ganham
-- a coluna automaticamente via SQLAlchemy create_all (backend/database/models.py User).

ALTER TABLE users
  ADD COLUMN display_name_format VARCHAR(20) NOT NULL DEFAULT 'first_initial';
