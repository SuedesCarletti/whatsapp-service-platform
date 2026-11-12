-- Migration: torna o compartilhamento das respostas rápidas opcional
-- (antes era sempre global; agora é pessoal por padrão, com opção de
-- compartilhar com a equipe). Executar uma única vez.

ALTER TABLE quick_replies
  ADD COLUMN is_shared TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '0 = pessoal (só o autor vê), 1 = compartilhado com a equipe'
    AFTER media_mime;

-- Atalho deixa de ser único globalmente (agora é único só dentro do
-- escopo: entre os compartilhados, e entre os pessoais de um mesmo autor).
ALTER TABLE quick_replies DROP INDEX ix_quick_replies_shortcut;
CREATE INDEX ix_quick_replies_shortcut ON quick_replies (shortcut);
