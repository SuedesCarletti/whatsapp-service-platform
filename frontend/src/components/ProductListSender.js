/**
 * ProductListSender Component
 *
 * Envia uma LISTA de produtos do catálogo, agrupados em seções — diferente
 * do ProductSender.js (que manda só 1 produto). Usa
 * POST /api/send/interactive/product-list, que já existia no backend mas
 * nunca tinha tela pra usar de verdade (o menu "Lista de Produtos" abria
 * o formulário de produto único por engano).
 */
import React, { useState, useEffect } from 'react';
import { MdClose, MdSend, MdAdd, MdDelete } from 'react-icons/md';
import { BsBoxSeam } from 'react-icons/bs';
import apiService, { api } from '../services/api';
import '../styles/ProductSender.css';
import '../styles/ProductListSender.css';

const emptySection = () => ({ title: '', products: [''] });

const ProductListSender = ({ conversation, onClose, onSent }) => {
  const [catalogId, setCatalogId] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [footerText, setFooterText] = useState('');
  const [sections, setSections] = useState([emptySection()]);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    (async () => {
      const accounts = await apiService.getAccounts();
      const acc = (accounts || []).find(a => (a.provider_type || '').startsWith('meta') && a.meta_catalog_id);
      if (acc) setCatalogId(acc.meta_catalog_id);
    })();
  }, []);

  const addSection = () => {
    if (sections.length >= 10) return;
    setSections(s => [...s, emptySection()]);
  };

  const removeSection = (idx) => {
    setSections(s => s.filter((_, i) => i !== idx));
  };

  const updateSectionTitle = (idx, title) => {
    setSections(s => s.map((sec, i) => (i === idx ? { ...sec, title } : sec)));
  };

  const addProduct = (sectionIdx) => {
    setSections(s => s.map((sec, i) => (i === sectionIdx ? { ...sec, products: [...sec.products, ''] } : sec)));
  };

  const updateProduct = (sectionIdx, productIdx, value) => {
    setSections(s => s.map((sec, i) => {
      if (i !== sectionIdx) return sec;
      const products = sec.products.map((p, j) => (j === productIdx ? value : p));
      return { ...sec, products };
    }));
  };

  const removeProduct = (sectionIdx, productIdx) => {
    setSections(s => s.map((sec, i) => {
      if (i !== sectionIdx) return sec;
      return { ...sec, products: sec.products.filter((_, j) => j !== productIdx) };
    }));
  };

  const isValid = () => {
    if (!catalogId.trim() || !headerText.trim() || !bodyText.trim()) return false;
    if (sections.length === 0) return false;
    return sections.every(sec => sec.title.trim() && sec.products.some(p => p.trim()));
  };

  const handleSend = async () => {
    if (!isValid()) {
      setError('Preencha o catálogo, cabeçalho, corpo, e ao menos 1 seção com título e 1 produto.');
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
        catalog_id: catalogId.trim(),
        header_text: headerText.trim(),
        body_text: bodyText.trim(),
        footer_text: footerText.trim() || undefined,
        sections: sections.map(sec => ({
          title: sec.title.trim(),
          product_items: sec.products.filter(p => p.trim()).map(p => ({ product_retailer_id: p.trim() })),
        })),
      };

      const response = await api.post('/api/send/interactive/product-list', payload);
      console.log('Lista de produtos enviada:', response.data);
      setSuccess(true);
      onSent?.();
      setTimeout(() => onClose(), 2000);
    } catch (err) {
      console.error('Erro ao enviar lista de produtos:', err);
      const detail = err?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Erro ao enviar lista de produtos');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="product-sender-overlay" onClick={onClose}>
      <div className="product-sender-modal" onClick={(e) => e.stopPropagation()}>
        <div className="product-sender-header">
          <div className="product-sender-title">
            <BsBoxSeam size={24} />
            <h2>Enviar Lista de Produtos</h2>
          </div>
          <button className="product-sender-close" onClick={onClose}>
            <MdClose size={24} />
          </button>
        </div>

        <div className="product-sender-body">
          <div className="product-info-box">
            <BsBoxSeam size={20} />
            <div>
              <strong>Como funciona:</strong>
              <p>Envie vários produtos do catálogo de uma vez, organizados em seções (ex: "Promoções", "Mais vendidos"). O cliente vê tudo numa lista e escolhe.</p>
            </div>
          </div>

          <div className="product-field">
            <label>ID do Catálogo *</label>
            <input type="text" placeholder="Ex: 123456789012345" value={catalogId} onChange={(e) => setCatalogId(e.target.value)} />
          </div>

          <div className="product-field">
            <label>Cabeçalho *</label>
            <input type="text" placeholder="Ex: Nossos produtos" maxLength={60} value={headerText} onChange={(e) => setHeaderText(e.target.value)} />
          </div>

          <div className="product-field">
            <label>Mensagem *</label>
            <textarea placeholder="Ex: Dá uma olhada nessa seleção que separei pra você!" value={bodyText} onChange={(e) => setBodyText(e.target.value)} rows={3} maxLength={1024} />
          </div>

          <div className="product-field">
            <label>Rodapé (opcional)</label>
            <input type="text" placeholder="Ex: Frete grátis acima de R$100" maxLength={60} value={footerText} onChange={(e) => setFooterText(e.target.value)} />
          </div>

          <div className="pls-sections">
            <div className="pls-sections-header">
              <label>Seções</label>
              {sections.length < 10 && (
                <button type="button" className="pls-btn-ghost" onClick={addSection}>
                  <MdAdd size={14} /> Adicionar seção
                </button>
              )}
            </div>

            {sections.map((sec, sIdx) => (
              <div key={sIdx} className="pls-section-card">
                <div className="pls-section-title-row">
                  <input
                    type="text"
                    placeholder={`Título da seção ${sIdx + 1} (ex: Promoções)`}
                    value={sec.title}
                    onChange={(e) => updateSectionTitle(sIdx, e.target.value)}
                  />
                  {sections.length > 1 && (
                    <button type="button" className="pls-icon-btn pls-icon-btn-danger" onClick={() => removeSection(sIdx)}>
                      <MdDelete size={16} />
                    </button>
                  )}
                </div>

                {sec.products.map((prod, pIdx) => (
                  <div key={pIdx} className="pls-product-row">
                    <span className="pls-product-tag">SKU</span>
                    <input
                      type="text"
                      placeholder="Ex: CAMISETA-AZUL-M"
                      value={prod}
                      onChange={(e) => updateProduct(sIdx, pIdx, e.target.value)}
                    />
                    {sec.products.length > 1 && (
                      <button type="button" className="pls-icon-btn pls-icon-btn-danger" onClick={() => removeProduct(sIdx, pIdx)}>
                        <MdDelete size={14} />
                      </button>
                    )}
                  </div>
                ))}
                <button type="button" className="pls-btn-ghost pls-btn-sm" onClick={() => addProduct(sIdx)}>
                  <MdAdd size={12} /> Adicionar produto
                </button>
              </div>
            ))}
          </div>

          {error && <div className="product-sender-error">⚠️ {error}</div>}
          {success && <div className="product-sender-success">Lista de produtos enviada com sucesso!</div>}
        </div>

        <div className="product-sender-footer">
          <button className="btn-cancel" onClick={onClose}>Cancelar</button>
          <button className="btn-send-product" onClick={handleSend} disabled={!isValid() || sending}>
            {sending ? (
              <><div className="spinner"></div>Enviando...</>
            ) : (
              <><MdSend />Enviar Lista</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProductListSender;
