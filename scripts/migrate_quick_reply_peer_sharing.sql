-- Migration: troca o compartilhamento "geral" (is_shared, equipe toda) das
-- respostas rápidas por compartilhamento ponto-a-ponto (autor escolhe com
-- quais colegas específicos compartilhar). Executar uma única vez.

CREATE TABLE IF NOT EXISTS quick_reply_shares (
  quick_reply_id INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (quick_reply_id, user_id),
  CONSTRAINT fk_qrs_quick_reply FOREIGN KEY (quick_reply_id) REFERENCES quick_replies(id) ON DELETE CASCADE,
  CONSTRAINT fk_qrs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE quick_replies DROP COLUMN is_shared;
