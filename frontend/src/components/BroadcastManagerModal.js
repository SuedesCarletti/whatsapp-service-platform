/**
 * BroadcastManagerModal — paridade com "Lista de transmissão" do WhatsApp
 * real: gerencia listas nomeadas de contatos de UMA conta e dispara uma
 * mensagem de texto pra todos os contatos de uma lista de uma vez (cada um
 * recebe como mensagem individual normal, não é grupo). Três telas dentro
 * do mesmo modal: lists -> edit -> compose/progresso.
 *
 * Contatos pra montar uma lista vêm do array `conversations` já carregado
 * em App.js (cada item tem `.contact.{id,name,phone_number,is_group}`) —
 * não existe endpoint dedicado "listar contatos", e não precisa de um: toda
 * pessoa que já trocou mensagem com a conta aparece ali.
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { BsX, BsArrowLeft, BsTrash, BsPencil, BsSend } from 'react-icons/bs';
import apiService from '../services/api';
import wsService from '../services/websocket';

const BroadcastManagerModal = ({ accountId, conversations, onClose }) => {
  const [view, setView] = useState('lists'); // lists | edit | compose
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeList, setActiveList] = useState(null); // lista sendo editada/usada pra disparo

  // ── Tela "edit" ──────────────────────────────────────────
  const [editName, setEditName] = useState('');
  const [editContactIds, setEditContactIds] = useState([]);
  const [contactFilter, setContactFilter] = useState('');

  // ── Tela "compose" ───────────────────────────────────────
  const [messageText, setMessageText] = useState('');
  const [activeSend, setActiveSend] = useState(null);

  const candidates = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const c of (conversations || [])) {
      if (!c.contact || c.contact.is_group) continue;
      if (seen.has(c.contact.id)) continue;
      seen.add(c.contact.id);
      out.push(c.contact);
    }
    return out.filter(c =>
      !contactFilter.trim() ||
      (c.name || '').toLowerCase().includes(contactFilter.toLowerCase()) ||
      (c.phone_number || '').includes(contactFilter)
    );
  }, [conversations, contactFilter]);

  const loadLists = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      setLists(await apiService.getBroadcastLists(accountId));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { loadLists(); }, [loadLists]);

  useEffect(() => {
    const handler = (data) => {
      setActiveSend(prev => (prev && prev.id === data.id) ? { ...prev, ...data } : prev);
    };
    wsService.on('broadcast_send_update', handler);
    return () => wsService.off('broadcast_send_update', handler);
  }, []);

  const openNewList = () => {
    setActiveList(null);
    setEditName('');
    setEditContactIds([]);
    setContactFilter('');
    setView('edit');
  };

  const openEditList = (list) => {
    setActiveList(list);
    setEditName(list.name);
    setEditContactIds(list.contacts.map(c => c.id));
    setContactFilter('');
    setView('edit');
  };

  const openCompose = (list) => {
    setActiveList(list);
    setMessageText('');
    setActiveSend(null);
    setView('compose');
  };

  const toggleContact = (id) => {
    setEditContactIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const saveList = async () => {
    const name = editName.trim();
    if (!name) { alert('Dê um nome pra lista.'); return; }
    if (editContactIds.length === 0) { alert('Selecione pelo menos um contato.'); return; }
    setLoading(true);
    try {
      if (activeList) {
        await apiService.updateBroadcastList(activeList.id, { name, contact_ids: editContactIds });
      } else {
        await apiService.createBroadcastList(accountId, name, editContactIds);
      }
      await loadLists();
      setView('lists');
    } catch (err) {
      alert(err.response?.data?.detail || 'Erro ao salvar lista.');
    } finally {
      setLoading(false);
    }
  };

  const removeList = async (list) => {
    if (!window.confirm(`Apagar a lista "${list.name}"? Isso não desfaz mensagens já enviadas.`)) return;
    await apiService.deleteBroadcastList(list.id);
    loadLists();
  };

  const sendNow = async () => {
    const text = messageText.trim();
    if (!text) return;
    setLoading(true);
    try {
      const send = await apiService.sendBroadcast(activeList.id, text);
      setActiveSend(send);
    } catch (err) {
      alert(err.response?.data?.detail || 'Erro ao iniciar disparo.');
    } finally {
      setLoading(false);
    }
  };

  const sending = activeSend && (activeSend.status === 'pending' || activeSend.status === 'sending');
  const progressPct = activeSend && activeSend.total
    ? Math.round(((activeSend.sent_count + activeSend.failed_count) / activeSend.total) * 100)
    : 0;

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: 460 }}>
        <div className="modal-header">
          {view !== 'lists' && (
            <button className="icon-btn" onClick={() => setView('lists')} style={{ marginRight: 4 }}>
              <BsArrowLeft size={20} />
            </button>
          )}
          <h3>
            {view === 'lists' && 'Listas de transmissão'}
            {view === 'edit' && (activeList ? 'Editar lista' : 'Nova lista')}
            {view === 'compose' && `Enviar · ${activeList?.name}`}
          </h3>
          <button className="icon-btn" onClick={onClose}>
            <BsX size={24} />
          </button>
        </div>

        <div className="modal-body">
          {view === 'lists' && (
            <>
              <button className="btn-primary" style={{ width: '100%', marginBottom: 12 }} onClick={openNewList}>
                + Nova lista
              </button>
              {loading ? (
                <small>Carregando...</small>
              ) : lists.length === 0 ? (
                <small style={{ color: 'var(--text-secondary, #888)' }}>Nenhuma lista de transmissão ainda.</small>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {lists.map(list => (
                    <div key={list.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      border: '1px solid var(--border-color, #ddd)', borderRadius: 6, padding: '8px 10px',
                    }}>
                      <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => openCompose(list)}>
                        <div style={{ fontWeight: 600 }}>{list.name}</div>
                        <small style={{ color: 'var(--text-secondary, #888)' }}>
                          {list.contact_count} contato{list.contact_count === 1 ? '' : 's'}
                        </small>
                      </div>
                      <button className="icon-btn" title="Enviar" onClick={() => openCompose(list)}>
                        <BsSend size={16} />
                      </button>
                      <button className="icon-btn" title="Editar" onClick={() => openEditList(list)}>
                        <BsPencil size={16} />
                      </button>
                      <button className="icon-btn" title="Apagar" onClick={() => removeList(list)}>
                        <BsTrash size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {view === 'edit' && (
            <>
              <div className="form-group">
                <label>Nome da lista</label>
                <input type="text" placeholder="ex: Clientes VIP" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Contatos ({editContactIds.length} selecionado{editContactIds.length === 1 ? '' : 's'})</label>
                <input
                  type="text" placeholder="Buscar por nome ou número..."
                  value={contactFilter} onChange={(e) => setContactFilter(e.target.value)}
                  style={{ marginBottom: 6 }}
                />
                <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 6, padding: 8 }}>
                  {candidates.length === 0 ? (
                    <small style={{ color: 'var(--text-secondary, #888)' }}>Nenhum contato encontrado.</small>
                  ) : candidates.map(c => (
                    <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 14, cursor: 'pointer' }}>
                      <input type="checkbox" checked={editContactIds.includes(c.id)} onChange={() => toggleContact(c.id)} />
                      {c.name || c.phone_number} <small style={{ color: 'var(--text-secondary, #888)' }}>({c.phone_number})</small>
                    </label>
                  ))}
                </div>
              </div>
              <button className="btn-primary" style={{ width: '100%', marginTop: 8 }} onClick={saveList} disabled={loading}>
                {loading ? 'Salvando...' : 'Salvar lista'}
              </button>
            </>
          )}

          {view === 'compose' && (
            <>
              <small style={{ color: 'var(--text-secondary, #888)' }}>
                {activeList?.contact_count} destinatário{activeList?.contact_count === 1 ? '' : 's'} — enviado individualmente pra cada um, com intervalo entre envios.
              </small>
              <div className="form-group" style={{ marginTop: 10 }}>
                <label>Mensagem</label>
                <textarea
                  rows={5} placeholder="Digite a mensagem a enviar para todos os contatos da lista..."
                  value={messageText} onChange={(e) => setMessageText(e.target.value)}
                  disabled={!!activeSend}
                />
              </div>

              {!activeSend && (
                <button className="btn-primary" style={{ width: '100%', marginTop: 8 }} onClick={sendNow} disabled={loading || !messageText.trim()}>
                  {loading ? 'Iniciando...' : `Enviar para ${activeList?.contact_count} contato${activeList?.contact_count === 1 ? '' : 's'}`}
                </button>
              )}

              {activeSend && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ width: '100%', height: 8, borderRadius: 4, background: 'var(--border-color, #ddd)', overflow: 'hidden' }}>
                    <div style={{
                      width: `${progressPct}%`, height: '100%',
                      background: activeSend.status === 'failed' ? '#d32f2f' : 'var(--whatsapp-green, #25d366)',
                      transition: 'width 0.3s',
                    }} />
                  </div>
                  <div style={{ marginTop: 6, fontSize: 13 }}>
                    {sending && `Enviando... ${activeSend.sent_count + activeSend.failed_count}/${activeSend.total}`}
                    {activeSend.status === 'done' && `Concluído: ${activeSend.sent_count} enviado(s), ${activeSend.failed_count} falha(s)`}
                    {activeSend.status === 'failed' && 'Disparo abortado — conta/provider indisponível.'}
                  </div>
                  {!sending && (
                    <button className="btn-primary" style={{ width: '100%', marginTop: 10 }} onClick={() => setView('lists')}>
                      Fechar
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default BroadcastManagerModal;
