/**
 * ProductSender Component
 * 
 * Enviar produto individual do catálogo
 * Integração com Meta Commerce Manager
 * Preview do produto
 * Corpo da mensagem customizável
 */
import React, { useState } from 'react';
import { MdClose, MdSend, MdShoppingBag, MdAttachMoney } from 'react-icons/md';
import { BsBoxSeam } from 'react-icons/bs';
import { api } from '../services/api';
import '../styles/ProductSender.css';

const ProductSender = ({ conversation, onClose, onSent }) => {
  const [productData, setProductData] = useState({
    catalog_id: '',
    product_retailer_id: '',
    body: ''
  });

  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  // Atualizar campo
  const updateField = (field, value) => {
    setProductData(prev => ({ ...prev, [field]: value }));
    setError(null);
  };

  // Validar dados
  const isValid = () => {
    return productData.catalog_id.trim() !== '' && 
           productData.product_retailer_id.trim() !== '' &&
           productData.body.trim() !== '';
  };

  // Enviar produto
  const handleSend = async () => {
    if (!isValid()) {
      setError('Preencha todos os campos obrigatórios');
      return;
    }

    if (!conversation) {
      setError('Nenhuma conversa selecionada');
      return;
    }

    try {
      setSending(true);
      setError(null);

      const payload = {
        to: conversation.contact?.wa_id || conversation.fromNumber,
        catalog_id: productData.catalog_id,
        product_retailer_id: productData.product_retailer_id,
        body: productData.body
      };

      const response = await api.post('/api/send/interactive/product', payload);

      console.log('Produto enviado:', response.data);
      setSuccess(true);
      onSent?.();

      setTimeout(() => {
        onClose();
      }, 2000);

    } catch (err) {
      console.error('Erro ao enviar produto:', err);
      setError(err.response?.data?.detail || 'Erro ao enviar produto');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="product-sender-overlay" onClick={onClose}>
      <div className="product-sender-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="product-sender-header">
          <div className="product-sender-title">
            <BsBoxSeam size={24} />
            <h2>Enviar Produto</h2>
          </div>
          <button className="product-sender-close" onClick={onClose}>
            <MdClose size={24} />
          </button>
        </div>

        {/* Body */}
        <div className="product-sender-body">
          {/* Instruções */}
          <div className="product-info-box">
            <MdShoppingBag size={20} />
            <div>
              <strong>Como funciona:</strong>
              <p>Envie um produto específico do seu catálogo do Meta Commerce Manager. O cliente poderá ver detalhes e comprar diretamente no WhatsApp.</p>
            </div>
          </div>

          {/* Catalog ID */}
          <div className="product-field">
            <label>
              <MdShoppingBag size={16} />
              ID do Catálogo *
            </label>
            <input
              type="text"
              placeholder="Ex: 123456789012345"
              value={productData.catalog_id}
              onChange={(e) => updateField('catalog_id', e.target.value)}
            />
            <small className="field-help">
              Encontre o ID do seu catálogo no Meta Commerce Manager
            </small>
          </div>

          {/* Product Retailer ID */}
          <div className="product-field">
            <label>
              <BsBoxSeam size={16} />
              SKU do Produto (Product Retailer ID) *
            </label>
            <input
              type="text"
              placeholder="Ex: PROD-001"
              value={productData.product_retailer_id}
              onChange={(e) => updateField('product_retailer_id', e.target.value)}
            />
            <small className="field-help">
              O SKU/ID único do produto no seu catálogo
            </small>
          </div>

          {/* Body */}
          <div className="product-field">
            <label>Mensagem *</label>
            <textarea
              placeholder="Ex: Olha só este produto incrível que separei para você!"
              value={productData.body}
              onChange={(e) => updateField('body', e.target.value)}
              rows={4}
              maxLength={1024}
            />
            <small>{productData.body.length}/1024 caracteres</small>
          </div>

          {/* Exemplo */}
          <div className="product-example">
            <div className="example-header">
              <strong>💡 Exemplo de IDs:</strong>
            </div>
            <div className="example-content">
              <div className="example-item">
                <span className="example-label">Catalog ID:</span>
                <code>123456789012345</code>
              </div>
              <div className="example-item">
                <span className="example-label">Product Retailer ID:</span>
                <code>CAMISETA-AZUL-M</code>
              </div>
            </div>
            <small>
              <strong>Onde encontrar:</strong> Meta Business Suite → Commerce Manager → Catálogo → Produto
            </small>
          </div>

          {/* Preview */}
          {isValid() && (
            <div className="product-preview">
              <div className="preview-label">📱 Preview</div>
              <div className="preview-bubble">
                <div className="preview-body">{productData.body}</div>
                <div className="preview-product-card">
                  <div className="preview-product-icon">
                    <BsBoxSeam size={40} />
                  </div>
                  <div className="preview-product-info">
                    <div className="preview-product-name">Produto do Catálogo</div>
                    <div className="preview-product-id">SKU: {productData.product_retailer_id}</div>
                  </div>
                </div>
                <div className="preview-product-button">
                  Ver Produto
                </div>
              </div>
            </div>
          )}

          {/* Messages */}
          {error && (
            <div className="product-sender-error">
              ⚠️ {error}
            </div>
          )}

          {success && (
            <div className="product-sender-success">
              ✅ Produto enviado com sucesso!
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="product-sender-footer">
          <button className="btn-cancel" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn-send-product"
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
                Enviar Produto
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProductSender;
