// LOCALIZAÇÃO: Criar novo arquivo em /frontend/src/components/senders/
// ARQUIVO COMPLETO NOVO

import React, { useState } from 'react';
import { MdClose, MdAddCircle, MdRemoveCircle, MdImage } from 'react-icons/md';
import { BsCardImage } from 'react-icons/bs';
import apiService from '../../services/api';
import { getRecipientJid } from '../../utils/recipient';
import '../../styles/CarouselSender.css';

const CarouselSender = ({ conversation, onClose, onSuccess }) => {
  const [cards, setCards] = useState([
    { id: 'card_1', header_media_id: '', body_text: '', footer_text: '', button_text: 'Ver mais' },
    { id: 'card_2', header_media_id: '', body_text: '', footer_text: '', button_text: 'Ver mais' }
  ]);
  const [sending, setSending] = useState(false);

  const addCard = () => {
    if (cards.length < 10) {
      setCards([...cards, {
        id: `card_${cards.length + 1}`,
        header_media_id: '',
        body_text: '',
        footer_text: '',
        button_text: 'Ver mais'
      }]);
    }
  };

  const removeCard = (index) => {
    if (cards.length > 2) {
      setCards(cards.filter((_, i) => i !== index));
    }
  };

  const updateCard = (index, field, value) => {
    const newCards = [...cards];
    newCards[index][field] = value;
    setCards(newCards);
  };

  const handleSend = async () => {
    // Validação
    const emptyCards = cards.filter(c => !c.body_text || !c.header_media_id);
    if (emptyCards.length > 0) {
      alert('Preencha o texto e a imagem de todos os cards');
      return;
    }

    setSending(true);
    try {
      await apiService.sendCarousel(getRecipientJid(conversation), cards);
      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Erro ao enviar carrossel:', error);
      alert('Erro ao enviar carrossel');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="carousel-sender-overlay" onClick={onClose}>
      <div className="carousel-sender-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="carousel-sender-header">
          <div className="carousel-sender-title">
            <BsCardImage size={24} />
            <h2>Enviar Carrossel</h2>
          </div>
          <button className="carousel-sender-close" onClick={onClose}>
            <MdClose size={24} />
          </button>
        </div>

        {/* Body */}
        <div className="carousel-sender-body">
          <p className="carousel-info">
            📱 Carrossel: 2-10 cards horizontais com imagem, texto e botão
          </p>

          {cards.map((card, index) => (
            <div key={card.id} className="carousel-card-editor">
              <div className="card-header-row">
                <span className="card-number">Card {index + 1}</span>
                {cards.length > 2 && (
                  <button
                    className="remove-card-btn"
                    onClick={() => removeCard(index)}
                  >
                    <MdRemoveCircle size={20} />
                  </button>
                )}
              </div>

              <div className="form-group">
                <label>Imagem (Media ID) *</label>
                <input
                  type="text"
                  placeholder="ID da mídia já enviada"
                  value={card.header_media_id}
                  onChange={(e) => updateCard(index, 'header_media_id', e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Texto Principal * (até 160 caracteres)</label>
                <textarea
                  placeholder="Ex: iPhone 15 Pro - 256GB"
                  maxLength={160}
                  value={card.body_text}
                  onChange={(e) => updateCard(index, 'body_text', e.target.value)}
                />
                <small>{card.body_text.length}/160</small>
              </div>

              <div className="form-group">
                <label>Rodapé (opcional)</label>
                <input
                  type="text"
                  placeholder="Ex: R$ 7.999,00"
                  value={card.footer_text}
                  onChange={(e) => updateCard(index, 'footer_text', e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Texto do Botão *</label>
                <input
                  type="text"
                  placeholder="Ex: Comprar"
                  maxLength={20}
                  value={card.button_text}
                  onChange={(e) => updateCard(index, 'button_text', e.target.value)}
                />
              </div>
            </div>
          ))}

          {cards.length < 10 && (
            <button className="add-card-btn" onClick={addCard}>
              <MdAddCircle size={20} />
              Adicionar Card ({cards.length}/10)
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="carousel-sender-footer">
          <button className="btn-cancel" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn-send"
            onClick={handleSend}
            disabled={sending}
          >
            {sending ? 'Enviando...' : 'Enviar Carrossel'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CarouselSender;
