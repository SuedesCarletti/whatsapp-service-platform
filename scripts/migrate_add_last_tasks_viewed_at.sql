-- Migration: nova coluna last_tasks_viewed_at em internal_conversation_participants
-- — mesma ideia de last_read_at (que já existe, pra mensagem), só que pra
-- tarefas: última vez que esse usuário expandiu/olhou a faixa de tarefas
-- dessa conversa. Tarefa criada depois disso conta como "não vista" (badge
-- vermelho no ícone de Tarefas do rail, na faixa da conversa, e no total do
-- painel global). NULL = nunca olhou (tudo que existir conta como não visto).
-- Executar uma única vez em bancos já existentes. Instalações novas ganham
-- a coluna automaticamente via SQLAlchemy create_all (backend/database/models.py
-- InternalConversationParticipant).

ALTER TABLE internal_conversation_participants
  ADD COLUMN last_tasks_viewed_at DATETIME NULL;
