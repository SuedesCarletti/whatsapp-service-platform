import React, { useState } from 'react';
import { MdClose, MdSend, MdAdd, MdDelete } from 'react-icons/md';
import axios from 'axios';
import '../styles/ListSender.css'; // Podemos reaproveitar parte dos estilos

const ButtonSender = ({ conversation, onClose }) => {
  const [buttonData, setButtonData] = useState({
    header: '',
    body: '',
    footer: '',
    buttons: [
      { id: 'btn_1', title: '' }
    ]
  });

  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const updateField = (field, value) => {
    setButtonData(prev => ({ ...prev, [field]: value }));
  };

  const addButton = () => {
    if (buttonData.buttons.length >= 3) {
      setError('Máximo de 3 botões permitidos pela Meta.');
      return;
    }
    setButtonData(prev => ({
      ...prev,
      buttons: [...prev.buttons, { id: `btn_${Date.now()}`, title: '' }]
    }));
  };

  const removeButton = (index) => {
    if (buttonData.buttons.length <= 1) {
      setError('A mensagem precisa de pelo menos 1 botão.');
      return;
    }
    setButtonData(prev => ({
      ...prev,
      buttons: prev.buttons.filter((_, i) => i !== index)
    }));
  };

  const updateButtonTitle = (index, value) => {
    if (value.length > 20) return; // Limite da API
    
    setButtonData(prev => {
      const newButtons = [...prev.buttons];
      newButtons[index].title = value;
      return { ...prev, buttons: newButtons };
    });
  };

  const handleSend = async () => {
    if (!buttonData.body.trim()) {
      setError('O texto principal (corpo) é obrigatório.');
      return;
    }

    const invalidButtons = buttonData.buttons.some(b => !b.title.trim());
    if (invalidButtons) {
      setError('Todos os botões precisam de um título.');
      return;
    }

    setSending(true);
    setError(null);

    try {
      const payload = {
        to: conversation.contact?.wa_id || conversation.contact?.phone_number,
        account_id: conversation.account_id,
        body_text: buttonData.body,
        buttons: buttonData.buttons.map(b => ({ id: b.id, title: b.title.trim() }))
      };

      if (buttonData.header.trim()) payload.header_text = buttonData.header.trim();
      if (buttonData.footer.trim()) payload.footer_text = buttonData.footer.trim();

      await axios.post('/api/send/interactive/buttons', payload);
      
      setSuccess(true);
      setTimeout(() => {
        onClose();
      }, 1500);
      
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.detail || err.message || 'Erro ao enviar botões.');
    } finally {
      setSending(false);
    }
  };

  if (!conversation) return null;

  return (
    <div className="list-sender-overlay">
      <div className="list-sender-modal" style={{ maxWidth: '500px' }}>
        <div className="list-sender-header">
          <h3>Enviar Botões Interativos</h3>
          <button className="icon-btn" onClick={onClose}><MdClose size={24} /></button>
        </div>

        <div className="list-sender-content">
          {error && <div className="error-alert">{error}</div>}
          {success && <div className="success-alert">Enviado com sucesso!</div>}

          <div className="form-group">
            <label>Cabeçalho (Opcional)</label>
            <input 
              type="text" 
              maxLength={60}
              placeholder="Ex: Promoção do Dia"
              value={buttonData.header}
              onChange={e => updateField('header', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label>Corpo da Mensagem (Obrigatório) *</label>
            <textarea 
              rows={4}
              maxLength={1024}
              placeholder="Digite o texto principal aqui..."
              value={buttonData.body}
              onChange={e => updateField('body', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label>Rodapé (Opcional)</label>
            <input 
              type="text" 
              maxLength={60}
              placeholder="Ex: Escolha uma opção abaixo"
              value={buttonData.footer}
              onChange={e => updateField('footer', e.target.value)}
            />
          </div>

          <div className="sections-container" style={{ marginTop: '20px' }}>
            <h4>Opções (Botões) - Mín: 1, Máx: 3</h4>
            {buttonData.buttons.map((btn, idx) => (
              <div key={btn.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' }}>
                <input
                  type="text"
                  placeholder={`Botão ${idx + 1}`}
                  value={btn.title}
                  maxLength={20}
                  onChange={e => updateButtonTitle(idx, e.target.value)}
                  style={{ flex: 1 }}
                />
                <button 
                  className="icon-btn danger" 
                  onClick={() => removeButton(idx)}
                  disabled={buttonData.buttons.length <= 1}
                  title="Remover botão"
                >
                  <MdDelete size={20} color="#d9534f" />
                </button>
              </div>
            ))}
            
            {buttonData.buttons.length < 3 && (
              <button className="add-btn" onClick={addButton} style={{ width: '100%', marginTop: '5px' }}>
                <MdAdd size={20} /> Adicionar Botão
              </button>
            )}
          </div>
        </div>

        <div className="list-sender-footer">
          <button className="cancel-btn" onClick={onClose} disabled={sending}>Cancelar</button>
          <button className="send-btn" onClick={handleSend} disabled={sending}>
            {sending ? 'Enviando...' : <><MdSend /> Enviar Botões</>}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ButtonSender;
