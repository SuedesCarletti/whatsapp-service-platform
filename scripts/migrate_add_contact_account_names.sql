-- Migration: nova tabela contact_account_names — nome customizado do
-- contato POR conta WhatsApp. Contact.wa_id é globalmente único (compartilhado
-- entre todas as contas da empresa que falam com aquele telefone), então
-- Contact.saved_name sozinho vazava o nome de um cliente entre contas
-- diferentes (ex: Atendente da Conta A renomeia, Conta B via o mesmo nome).
-- Daqui pra frente, o nome customizado de um contato passa a valer só pra
-- conta em que foi definido — cada conta pode ter seu próprio nome pro
-- mesmo telefone. Backfill abaixo preserva o nome que cada conta já via até
-- agora (baseado em Contact.saved_name), pra ninguém perder o que já tinha
-- salvo; dali em diante cada conta diverge independente.
-- Executar uma única vez (backend/teste e prod compartilham o mesmo MySQL).
-- Instalações novas ganham a tabela automaticamente via SQLAlchemy create_all
-- (backend/database/models.py, classe ContactAccountName).

CREATE TABLE IF NOT EXISTS contact_account_names (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contact_id INT NOT NULL,
  account_id INT NOT NULL,
  custom_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY ux_contact_account_names_contact_account (contact_id, account_id),
  KEY ix_contact_account_names_contact_id (contact_id),
  KEY ix_contact_account_names_account_id (account_id),
  CONSTRAINT fk_can_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  CONSTRAINT fk_can_account FOREIGN KEY (account_id) REFERENCES whatsapp_accounts(id) ON DELETE CASCADE
);

INSERT INTO contact_account_names (contact_id, account_id, custom_name, created_at, updated_at)
SELECT DISTINCT c.contact_id, c.account_id, ct.saved_name, NOW(), NOW()
FROM conversations c
JOIN contacts ct ON ct.id = c.contact_id
WHERE ct.saved_name IS NOT NULL AND ct.saved_name != '' AND c.account_id IS NOT NULL
ON DUPLICATE KEY UPDATE custom_name = VALUES(custom_name);
