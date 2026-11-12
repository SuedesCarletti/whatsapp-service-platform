-- Migration: rastrear quando a pesquisa de CSAT foi enviada, separado da
-- flag awaiting_csat (que é limpa ao responder ou por timeout). Sem isso não
-- dá pra calcular taxa de resposta (respostas / pesquisas enviadas) num
-- período depois que a flag já virou False. Ver /api/attendance/reports.
-- Executar uma vez.

ALTER TABLE conversations
  ADD COLUMN csat_sent_at DATETIME NULL AFTER awaiting_csat;
