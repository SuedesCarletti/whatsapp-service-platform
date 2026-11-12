/**
 * NewInternalChatModal — inicia uma DM (1 pessoa, incluindo "Você" pra
 * mensagens/tarefas pra si mesmo) ou cria um grupo (2+) de chat interno.
 * Lista de usuários vem de apiService.getAgents() (mesma usada pra
 * atribuição de conversa de cliente), exclui o próprio usuário logado (que
 * já aparece à parte, como a opção "Você").
 */
import React, { useState } from 'react';
import { BsX } from 'react-icons/bs';
import apiService from '../services/api';

const NewInternalChatModal = ({ agents, currentUserId, onClose, onCreated }) => {
  const [selectedIds, setSelectedIds] = useState([]);
  const [selfSelected, setSelfSelected] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [loading, setLoading] = useState(false);

  const candidates = (agents || []).filter(a => a.id !== currentUserId);
  const isGroup = selectedIds.length > 1;

  // "Você" é uma opção à parte, exclusiva com o resto da lista — não faz
  // sentido "incluir a si mesmo" num grupo (você já é sempre membro), então
  // marcá-la sempre inicia (ou abre) a conversa consigo mesmo, sem misturar
  // com a seleção de outras pessoas pra grupo.
  const toggleSelf = () => {
    setSelfSelected(prev => !prev);
    setSelectedIds([]);
  };

  const toggle = (id) => {
    setSelfSelected(false);
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSubmit = async () => {
    if (!selfSelected && selectedIds.length === 0) return;
    if (isGroup && !groupName.trim()) {
      alert('Dê um nome pro grupo.');
      return;
    }
    setLoading(true);
    try {
      const res = selfSelected
        ? await apiService.getOrCreateInternalDM(currentUserId)
        : isGroup
        ? await apiService.createInternalGroup(groupName.trim(), selectedIds)
        : await apiService.getOrCreateInternalDM(selectedIds[0]);
      if (res?.data) {
        onCreated(res.data);
        onClose();
      } else {
        alert(res?.message || 'Não foi possível criar a conversa.');
      }
    } catch (err) {
      alert(err.response?.data?.detail || 'Erro ao criar conversa.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: 400 }}>
        <div className="modal-header">
          <h3>Nova conversa interna</h3>
          <button className="icon-btn" onClick={onClose} disabled={loading}>
            <BsX size={24} />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label>Com quem? (marque mais de um pra criar um grupo)</label>
            <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 6, padding: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 14, cursor: 'pointer', borderBottom: '1px solid var(--border-color, #ddd)', marginBottom: 4 }}>
                <input type="checkbox" checked={selfSelected} onChange={toggleSelf} />
                Você <small style={{ color: 'var(--text-secondary, #888)' }}>(mensagens para você mesmo)</small>
              </label>
              {candidates.length === 0 ? (
                <small style={{ color: 'var(--text-secondary, #888)' }}>Nenhum outro usuário cadastrado.</small>
              ) : candidates.map(a => (
                <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 14, cursor: 'pointer' }}>
                  <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => toggle(a.id)} />
                  {a.full_name} {a.sector ? <small style={{ color: 'var(--text-secondary, #888)' }}>({a.sector})</small> : null}
                </label>
              ))}
            </div>
          </div>

          {isGroup && (
            <div className="form-group">
              <label>Nome do grupo</label>
              <input
                type="text"
                placeholder="ex: Equipe Suporte"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
              />
            </div>
          )}

          <button
            className="btn-primary"
            style={{ width: '100%', marginTop: 8 }}
            onClick={handleSubmit}
            disabled={loading || (!selfSelected && selectedIds.length === 0)}
          >
            {loading ? 'Criando...' : isGroup ? 'Criar grupo' : 'Iniciar conversa'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewInternalChatModal;
