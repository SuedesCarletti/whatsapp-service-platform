# Sync de histórico, backup e mescla WPPConnect + Baileys

## Visão geral
| Peça | O que faz |
|---|---|
| **Portão de carga** | O backend expõe `GET /api/webhook/bridge/load`. Os bridges consultam antes de cada lote de histórico e esperam enquanto o backend estiver ocupado. Mensagem ao vivo e catch-up têm prioridade e **nunca** são recusados. |
| **Admissão no backend** | `POST /api/webhook/bridge/sync` (histórico, não-catchup) responde `429` + `Retry-After` quando o sistema está `overloaded`. |
| **Backfill WPPConnect** | Pagina até o fim real de cada conversa (200 páginas x 50, 1000 conversas por padrão), automático, uma sessão por vez. Falha do backend **não avança o cursor**: a conversa fica pendente para a próxima rodada. |
| **Backup Baileys** | Todo `messaging-history.set` é gravado **sem teto** em `BACKUP_DIR` (JSONL.gz por conversa + `index.json`) e encaminhado ao backend em segundo plano. |
| **Mescla** | Histórico de uma conta companion (Baileys com `fallback_for_account_id`) é gravado na conta **primária** (WPPConnect), deduplicado por `wamid`. Tráfego ao vivo da companion segue ignorado. |

## Variáveis de ambiente
| Variável | Padrão | Onde | Efeito |
|---|---|---|---|
| `HISTORY_GATE_LIVE_BUSY_PER_MIN` | 20 | backend | msgs ao vivo/min a partir das quais o nível vira `busy` |
| `HISTORY_GATE_QUEUE_BUSY` / `_OVERLOADED` | 5 / 20 | backend | profundidade da fila do executor para `busy` / `overloaded` |
| `HISTORY_MERGE_FROM_FALLBACK` | true | backend + baileys | liga/desliga a mescla de histórico da companion |
| `BACKFILL_AUTO_ENABLED` | true | wppconnect | backfill automático ao conectar |
| `BACKFILL_MAX_PAGES_PER_CHAT` / `BACKFILL_MAX_CHATS` | 200 / 1000 | wppconnect | tetos do backfill |
| `BAILEYS_HISTORY_PROFILE` | full | baileys | `full` = perfil Desktop + syncFullHistory; `default` = perfil antigo |
| `HISTORY_FORWARD_ENABLED` | true | baileys | encaminha histórico ao backend (o backup em disco sempre grava) |
| `BACKUP_DIR` | `./backup` | baileys | raiz do backup (no compose de teste: volume `baileys_backup`) |

## Endpoints do bridge Baileys (porta 3001)
| Método | Rota | Uso |
|---|---|---|
| GET | `/backup/status?session_id=` | totais, conversas (mais recentes primeiro) e últimos eventos de sync |
| GET | `/backup/download?session_id=` | `tar.gz` com mensagens, chats, contatos, mídia e índice |
| POST | `/backup/history/fetch` `{session_id, jid, count}` | pede ao celular mensagens mais antigas de um chat (on-demand) |
| POST | `/backup/replay` `{session_id, jid?}` | reenvia o backup ao backend (idempotente por `wamid`) |
| POST | `/backup/media` `{session_id, jid, id}` | baixa a mídia de uma mensagem sob demanda |

## Checklist antes de parear um número
1. Backend no ar e `GET /api/webhook/bridge/load` retornando `level: ok`.
2. Conta primária (WPPConnect) criada; companion criada **apontando para ela** (`fallback_for_account_id`).
3. `BACKUP_DIR` em volume persistente e com espaço (histórico longo pesa).
4. **Parear o Baileys com `BAILEYS_HISTORY_PROFILE=full`**: o histórico profundo só é entregue no pareamento.
5. Conferir `/backup/status` ao fim do sync (`last_events` e `totals`).

## Limites conhecidos
- O WhatsApp decide quanto histórico entrega; "completo" é "o máximo que o celular/servidor fornece".
- O backup em disco deduplica na **leitura**; o mesmo evento pode aparecer duas vezes após um restart.
- Dois aparelhos vinculados ao mesmo número aumentam o risco de banimento.
- Mídia antiga pode ter expirado nos servidores do WhatsApp (`/backup/media` pode falhar).
