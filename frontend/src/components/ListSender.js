/**
 * ListSender Component
 * 
 * Enviar listas interativas (até 10 itens)
 * Múltiplas seções
 * Descrições opcionais
 * Preview da lista
 */
import React, { useState } from 'react';
import { MdClose, MdSend, MdList, MdAdd, MdDelete } from 'react-icons/md';
import { BsListUl, BsPlus, BsTrash } from 'react-icons/bs';
import { api } from '../services/api';
import '../styles/ListSender.css';

const ListSender = ({ conversation, onClose, onSent }) => {
  const [listData, setListData] = useState({
    header: '',
    body: '',
    footer: '',
    button_text: 'Ver Opções',
    sections: [
      {
        title: 'Seção 1',
        rows: [
          { id: 'item_1', title: '', description: '' }
        ]
      }
    ]
  });

  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  // Atualizar campo principal
  const updateField = (field, value) => {
    setListData(prev => ({ ...prev, [field]: value }));
  };

  // Adicionar seção
  const addSection = () => {
    if (listData.sections.length >= 10) {
      setError('Máximo de 10 seções permitidas');
      return;
    }

    setListData(prev => ({
      ...prev,
      sections: [...prev.sections, {
        title: `Seção ${prev.sections.length + 1}`,
        rows: [{ id: `item_${Date.now()}`, title: '', description: '' }]
      }]
    }));
  };

  // Remover seção
  const removeSection = (sectionIndex) => {
    if (listData.sections.length === 1) {
      setError('Deve ter pelo menos uma seção');
      return;
    }

    setListData(prev => ({
      ...prev,
      sections: prev.sections.filter((_, i) => i !== sectionIndex)
    }));
  };

  // Atualizar seção
  const updateSection = (sectionIndex, field, value) => {
    setListData(prev => ({
      ...prev,
      sections: prev.sections.map((section, i) => 
        i === sectionIndex ? { ...section, [field]: value } : section
      )
    }));
  };

  // Adicionar item na seção
  const addRow = (sectionIndex) => {
    const totalRows = listData.sections.reduce((sum, s) => sum + s.rows.length, 0);
    
    if (totalRows >= 10) {
      setError('Máximo de 10 itens no total permitidos');
      return;
    }

    setListData(prev => ({
      ...prev,
      sections: prev.sections.map((section, i) => 
        i === sectionIndex 
          ? { ...section, rows: [...section.rows, { id: `item_${Date.now()}`, title: '', description: '' }] }
          : section
      )
    }));
  };

  // Remover item
  const removeRow = (sectionIndex, rowIndex) => {
    setListData(prev => ({
      ...prev,
      sections: prev.sections.map((section, i) => 
        i === sectionIndex 
          ? { ...section, rows: section.rows.filter((_, r) => r !== rowIndex) }
          : section
      )
    }));
  };

  // Atualizar item
  const updateRow = (sectionIndex, rowIndex, field, value) => {
    setListData(prev => ({
      ...prev,
      sections: prev.sections.map((section, i) => 
        i === sectionIndex 
          ? {
              ...section,
              rows: section.rows.map((row, r) => 
                r === rowIndex ? { ...row, [field]: value } : row
              )
            }
          : section
      )
    }));
  };

  // Validar lista
  const isValid = () => {
    if (!listData.body.trim()) return false;
    if (!listData.button_text.trim()) return false;
    
    // Verificar se há pelo menos um item com título
    const hasValidItem = listData.sections.some(section => 
      section.rows.some(row => row.title.trim() !== '')
    );
    
    return hasValidItem;
  };

  // Enviar lista
  const handleSend = async () => {
    if (!isValid()) {
      setError('Preencha o corpo da mensagem, texto do botão e pelo menos um item');
      return;
    }

    if (!conversation) {
      setError('Nenhuma conversa selecionada');
      return;
    }

    try {
      setSending(true);
      setError(null);

      // Limpar dados vazios
      const cleanedSections = listData.sections
        .map(section => ({
          ...section,
          rows: section.rows.filter(row => row.title.trim() !== '')
        }))
        .filter(section => section.rows.length > 0);

      const payload = {
        to: conversation.contact?.wa_id || conversation.fromNumber,
        button_text: listData.button_text,
        body: listData.body,
        sections: cleanedSections
      };

      if (listData.header) payload.header = listData.header;
      if (listData.footer) payload.footer = listData.footer;

      const response = await api.post('/api/send/interactive/list', payload);

      console.log('Lista enviada:', response.data);
      setSuccess(true);
      onSent?.();

      setTimeout(() => {
        onClose();
      }, 2000);

    } catch (err) {
      console.error('Erro ao enviar lista:', err);
      setError(err.response?.data?.detail || 'Erro ao enviar lista');
    } finally {
      setSending(false);
    }
  };

  // Contar total de itens
  const getTotalItems = () => {
    return listData.sections.reduce((sum, s) => sum + s.rows.filter(r => r.title.trim()).length, 0);
  };

  return (
    <div className="list-sender-overlay" onClick={onClose}>
      <div className="list-sender-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="list-sender-header">
          <div className="list-sender-title">
            <BsListUl size={24} />
            <h2>Enviar Lista Interativa</h2>
          </div>
          <button className="list-sender-close" onClick={onClose}>
            <MdClose size={24} />
          </button>
        </div>

        {/* Body */}
        <div className="list-sender-body">
          {/* Informações */}
          <div className="list-info">
            <div className="list-info-item">
              <strong>Itens:</strong> {getTotalItems()}/10
            </div>
            <div className="list-info-item">
              <strong>Seções:</strong> {listData.sections.length}/10
            </div>
          </div>

          {/* Campos principais */}
          <div className="list-field">
            <label>Cabeçalho (opcional)</label>
            <input
              type="text"
              placeholder="Ex: Menu Principal"
              value={listData.header}
              onChange={(e) => updateField('header', e.target.value)}
              maxLength={60}
            />
            <small>{listData.header.length}/60</small>
          </div>

          <div className="list-field">
            <label>Corpo da Mensagem *</label>
            <textarea
              placeholder="Ex: Escolha uma opção abaixo"
              value={listData.body}
              onChange={(e) => updateField('body', e.target.value)}
              rows={3}
              maxLength={1024}
            />
            <small>{listData.body.length}/1024</small>
          </div>

          <div className="list-field">
            <label>Rodapé (opcional)</label>
            <input
              type="text"
              placeholder="Ex: Selecione para continuar"
              value={listData.footer}
              onChange={(e) => updateField('footer', e.target.value)}
              maxLength={60}
            />
            <small>{listData.footer.length}/60</small>
          </div>

          <div className="list-field">
            <label>Texto do Botão *</label>
            <input
              type="text"
              placeholder="Ex: Ver Opções"
              value={listData.button_text}
              onChange={(e) => updateField('button_text', e.target.value)}
              maxLength={20}
            />
            <small>{listData.button_text.length}/20</small>
          </div>

          {/* Seções e Itens */}
          <div className="sections-container">
            <div className="sections-header">
              <h3>Seções e Itens</h3>
              <button className="btn-add-section-small" onClick={addSection}>
                <BsPlus /> Nova Seção
              </button>
            </div>

            {listData.sections.map((section, sectionIndex) => (
              <div key={sectionIndex} className="section-block">
                <div className="section-block-header">
                  <input
                    type="text"
                    placeholder="Nome da Seção"
                    value={section.title}
                    onChange={(e) => updateSection(sectionIndex, 'title', e.target.value)}
                    className="section-title-input"
                  />
                  {listData.sections.length > 1 && (
                    <button
                      className="btn-remove-section"
                      onClick={() => removeSection(sectionIndex)}
                    >
                      <BsTrash />
                    </button>
                  )}
                </div>

                <div className="rows-container">
                  {section.rows.map((row, rowIndex) => (
                    <div key={rowIndex} className="row-item">
                      <div className="row-fields">
                        <input
                          type="text"
                          placeholder="Título do Item *"
                          value={row.title}
                          onChange={(e) => updateRow(sectionIndex, rowIndex, 'title', e.target.value)}
                          maxLength={24}
                        />
                        <input
                          type="text"
                          placeholder="Descrição (opcional)"
                          value={row.description}
                          onChange={(e) => updateRow(sectionIndex, rowIndex, 'description', e.target.value)}
                          maxLength={72}
                        />
                      </div>
                      {section.rows.length > 1 && (
                        <button
                          className="btn-remove-row"
                          onClick={() => removeRow(sectionIndex, rowIndex)}
                        >
                          <MdDelete size={18} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <button
                  className="btn-add-row"
                  onClick={() => addRow(sectionIndex)}
                  disabled={getTotalItems() >= 10}
                >
                  <MdAdd /> Adicionar Item
                </button>
              </div>
            ))}
          </div>

          {/* Messages */}
          {error && (
            <div className="list-sender-error">
              ⚠️ {error}
            </div>
          )}

          {success && (
            <div className="list-sender-success">
              Lista enviada com sucesso!
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="list-sender-footer">
          <button className="btn-cancel" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn-send-list"
            onClick={handleSend}
            disabled={!isValid() || sending}
          >
            {sending ? (
              <>
                <div className="spinner"></div>
                Enviando...
              </>
            ) : (
              <>
                <MdSend />
                Enviar Lista
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ListSender;
