-- Migration: adiciona suporte a mídia nas respostas rápidas (quick_replies)
-- Executar uma única vez em bancos de dados já existentes.

ALTER TABLE quick_replies
  MODIFY text TEXT NULL;

ALTER TABLE quick_replies
  ADD COLUMN media_url VARCHAR(500) DEFAULT NULL
    COMMENT 'Caminho relativo em uploads/, ex: /uploads/xxx.jpg'
    AFTER text,
  ADD COLUMN media_type VARCHAR(20) DEFAULT NULL
    COMMENT 'image|video|audio|document|sticker'
    AFTER media_url,
  ADD COLUMN media_filename VARCHAR(255) DEFAULT NULL
    AFTER media_type,
  ADD COLUMN media_mime VARCHAR(100) DEFAULT NULL
    AFTER media_filename;
