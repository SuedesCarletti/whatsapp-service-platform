/**
 * TaskModal — criar uma tarefa em qualquer um dos 3 modos:
 *
 * 1. Chat INTERNO (DM ou grupo da equipe) — `conversation` fixa (a partir
 *    do composer do InternalChatArea) ou `conversations`+`defaultConversationId`
 *    em modo seletor. Posta um card na timeline do chat, tarefa lista nos
 *    "Dados do contato"/"Dados do grupo".
 * 2. PESSOAL (`standalone`, sem `customerConversationId`) — a partir do
 *    painel global "Minhas tarefas" (MyTasksPanel). Pedido explícito
 *    2026-09-23: não força nenhuma conversa (antes usava a DM "Você mesmo"
 *    como container obrigatório, poluindo uma conversa pensada só pra
 *    anotações com avisos de sistema toda hora). Responsável vem de
 *    `agents` (toda a equipe), não de participantes de conversa nenhuma.
 * 3. Conversa de CLIENTE (`standalone` + `customerConversationId`) — a
 *    partir do ChatArea.js (chat com o cliente). Controle exclusivo de
 *    quem cria: sem seletor de responsável (sempre autoatribuída no
 *    backend), e NUNCA gera nada visível pro cliente — só um to-do interno
 *    grudado naquela conversa.
 */
import React, { useState } from 'react';
import { BsX, BsListCheck } from 'react-icons/bs';

// 0=segunda...6=domingo — mesma convenção de datetime.weekday() usada no backend.
const WEEKDAY_LABELS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

// low|medium|high|urgent — mesma convenção usada no backend (TASK_PRIORITIES).
const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Baixa' },
  { value: 'medium', label: 'Média' },
  { value: 'high', label: 'Alta' },
  { value: 'urgent', label: 'Urgente' },
];

const TaskModal = ({
  conversation, conversations, defaultConversationId, currentUserId,
  standalone = false, customerConversationId = null, agents,
  onClose, onCreate,
}) => {
  const isPicker = !conversation && !standalone;
  const [selectedConvId, setSelectedConvId] = useState(
    defaultConversationId || conversations?.[0]?.id || ''
  );
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [priority, setPriority] = useState('medium');
  const [recurrenceInterval, setRecurrenceInterval] = useState(''); // '' = não repete
  const [recurrenceEvery, setRecurrenceEvery] = useState('1');
  const [recurrenceDays, setRecurrenceDays] = useState([]); // só p/ weekly — 0=segunda...6=domingo
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const activeConversation = conversation || (conversations || []).find(c => c.id === Number(selectedConvId));
  // Pessoal: responsável vem da equipe toda (agents), não tem roster de
  // conversa pra restringir. Cliente: sem picker nenhum (ver showAssignee abaixo).
  const participants = standalone ? (agents || []) : (activeConversation?.participants || []);
  const targetConvId = standalone ? null : (conversation ? conversation.id : Number(selectedConvId) || null);
  const canSave = title.trim().length > 0 && (standalone || !!targetConvId) && !saving;
  const showAssigneePicker = !customerConversationId;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        description: description.trim() || undefined,
        assignedTo: (showAssigneePicker && assignedTo) ? Number(assignedTo) : undefined,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        priority,
        recurrenceInterval: recurrenceInterval || undefined,
        recurrenceEvery: recurrenceInterval ? (Number(recurrenceEvery) || 1) : undefined,
        recurrenceDaysOfWeek: recurrenceInterval === 'weekly' && recurrenceDays.length ? recurrenceDays : undefined,
        customerConversationId: customerConversationId || undefined,
      }, targetConvId);
      onClose();
    } catch (err) {
      setError(err.response?.data?.detail || 'Não foi possível criar a tarefa.');
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3><BsListCheck style={{ verticalAlign: -3, marginRight: 6 }} /> Nova tarefa</h3>
          <button className="modal-close" onClick={onClose}><BsX size={22} /></button>
        </div>

        <div className="modal-body" style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {isPicker && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Conversa</label>
              <select value={selectedConvId} onChange={(e) => { setSelectedConvId(e.target.value); setAssignedTo(''); }} style={{ width: '100%' }}>
                <option value="">Selecione...</option>
                {(conversations || []).map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Título</label>
            <input
              type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Ex: Ligar para o fornecedor" autoFocus style={{ width: '100%' }}
            />
          </div>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Descrição (opcional)</label>
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Detalhes da tarefa" rows={3} style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          {customerConversationId && (
            <div style={{
              fontSize: 12, padding: '8px 10px', borderRadius: 8,
              background: 'var(--bg-secondary, #f9f9f9)', borderLeft: '3px solid var(--brand-orange, #0EA5A4)',
            }}>
              🔒 Só pra você — vinculada a esta conversa pro seu controle, o cliente nunca vê nem recebe nada sobre isso.
            </div>
          )}

          {showAssigneePicker && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Responsável (opcional)</label>
              <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} style={{ width: '100%' }}>
                <option value="">Ninguém em especial</option>
                {participants.map(p => (
                  <option key={p.id} value={p.id}>{p.full_name}{p.id === currentUserId ? ' (você)' : ''}</option>
                ))}
              </select>
              {standalone && assignedTo && Number(assignedTo) !== currentUserId && (
                <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>
                  Vai aparecer na conversa com essa pessoa (cria automaticamente se ainda não existir).
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Prazo (opcional)</label>
              <input
                type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Urgência</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: '100%' }}>
                {PRIORITY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Repetir (opcional)</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {recurrenceInterval && recurrenceInterval !== 'weekly' && (
                <>
                  <span style={{ fontSize: 13 }}>A cada</span>
                  <input
                    type="number" min={1} value={recurrenceEvery}
                    onChange={(e) => setRecurrenceEvery(e.target.value)}
                    style={{ width: 56 }}
                  />
                </>
              )}
              <select
                value={recurrenceInterval}
                onChange={(e) => { setRecurrenceInterval(e.target.value); setRecurrenceDays([]); }}
                style={{ flex: 1 }}
              >
                <option value="">Não repete</option>
                <option value="daily">dia(s)</option>
                <option value="weekly">semana(s)</option>
                <option value="monthly">mês(es)</option>
              </select>
            </div>

            {recurrenceInterval === 'weekly' && (
              <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                {WEEKDAY_LABELS.map((label, idx) => {
                  const active = recurrenceDays.includes(idx);
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setRecurrenceDays(prev => active ? prev.filter(d => d !== idx) : [...prev, idx].sort())}
                      style={{
                        width: 40, height: 32, borderRadius: 16, fontSize: 12.5, fontWeight: 600,
                        border: '1px solid var(--border-color, #ddd)', cursor: 'pointer',
                        background: active ? 'var(--brand-orange, #0EA5A4)' : 'transparent',
                        color: active ? '#fff' : 'var(--text-primary)',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
            {recurrenceInterval === 'weekly' && recurrenceDays.length === 0 && (
              <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>
                Nenhum dia marcado — repete no mesmo dia da semana do prazo, a cada semana.
              </div>
            )}
            {recurrenceInterval && (
              <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>
                A próxima ocorrência só é criada quando esta for concluída E aprovada.
              </div>
            )}
          </div>

          {error && <div style={{ fontSize: 13, color: '#e53e3e' }}>{error}</div>}

          <button className="btn-primary" style={{ width: '100%' }} onClick={handleSave} disabled={!canSave}>
            {saving ? 'Criando...' : 'Criar tarefa'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TaskModal;
