/**
 * CartBuilder - Construtor de Carrinho de Compras
 * 
 * Permite adicionar produtos e enviar carrinho via WhatsApp
 */
import React, { useState } from 'react';
import { FiShoppingCart, FiPlus, FiMinus, FiTrash2, FiSend, FiX } from 'react-icons/fi';
import { api } from '../services/api';
import '../styles/CartBuilder.css';

const CartBuilder = ({ contactPhone, contactName, onClose, onSent }) => {
  const [catalogId, setCatalogId] = useState('');
  const [items, setItems] = useState([]);
  const [newItem, setNewItem] = useState({
    product_retailer_id: '',
    quantity: 1,
    item_price: '',
    currency: 'BRL'
  });
  const [sending, setSending] = useState(false);

  // Adicionar item ao carrinho
  const handleAddItem = () => {
    if (!newItem.product_retailer_id.trim() || !newItem.item_price) {
      alert('Preencha SKU e Preço');
      return;
    }

    const item = {
      ...newItem,
      item_price: parseFloat(newItem.item_price)
    };

    setItems([...items, item]);
    
    // Resetar formulário
    setNewItem({
      product_retailer_id: '',
      quantity: 1,
      item_price: '',
      currency: 'BRL'
    });
  };

  // Remover item do carrinho
  const handleRemoveItem = (index) => {
    setItems(items.filter((_, i) => i !== index));
  };

  // Atualizar quantidade de item
  const handleUpdateQuantity = (index, delta) => {
    const newItems = [...items];
    const newQuantity = newItems[index].quantity + delta;
    
    if (newQuantity >= 1) {
      newItems[index].quantity = newQuantity;
      setItems(newItems);
    }
  };

  // Calcular total do carrinho
  const calculateTotal = () => {
    return items.reduce((total, item) => total + (item.item_price * item.quantity), 0);
  };

  // Enviar carrinho
  const handleSend = async () => {
    if (!catalogId.trim()) {
      alert('Digite o ID do Catálogo');
      return;
    }

    if (items.length === 0) {
      alert('Adicione pelo menos um item ao carrinho');
      return;
    }

    try {
      setSending(true);

      await api.post('/api/extended/send/cart', {
        to: contactPhone,
        catalog_id: catalogId,
        product_items: items
      });

      alert(`Carrinho enviado com sucesso para ${contactName}!`);
      
      if (onSent) {
        onSent();
      }
      
      if (onClose) {
        onClose();
      }
    } catch (error) {
      console.error('Erro ao enviar carrinho:', error);
      alert('Erro ao enviar carrinho: ' + (error.response?.data?.detail || error.message));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="cart-builder-overlay">
      <div className="cart-builder-modal">
        {/* Header */}
        <div className="cart-header">
          <div>
            <h2><FiShoppingCart /> Carrinho de Compras</h2>
            <p>Enviando para: <strong>{contactName}</strong></p>
          </div>
          <button className="close-button" onClick={onClose}>
            <FiX />
          </button>
        </div>

        {/* Catalog ID */}
        <div className="cart-section">
          <label>
            ID do Catálogo:
            <input
              type="text"
              value={catalogId}
              onChange={(e) => setCatalogId(e.target.value)}
              placeholder="Cole o ID do catálogo aqui"
            />
            <small>Obtenha no Commerce Manager</small>
          </label>
        </div>

        {/* Add Item Form */}
        <div className="cart-section">
          <h3>Adicionar Produto</h3>
          
          <div className="add-item-form">
            <input
              type="text"
              placeholder="SKU do Produto"
              value={newItem.product_retailer_id}
              onChange={(e) => setNewItem({...newItem, product_retailer_id: e.target.value})}
            />
            
            <input
              type="number"
              placeholder="Quantidade"
              min="1"
              value={newItem.quantity}
              onChange={(e) => setNewItem({...newItem, quantity: parseInt(e.target.value) || 1})}
            />
            
            <input
              type="number"
              step="0.01"
              placeholder="Preço (R$)"
              value={newItem.item_price}
              onChange={(e) => setNewItem({...newItem, item_price: e.target.value})}
            />
            
            <button 
              className="btn-add-item"
              onClick={handleAddItem}
            >
              <FiPlus /> Adicionar
            </button>
          </div>
        </div>

        {/* Cart Items */}
        <div className="cart-section cart-items">
          <h3>Itens do Carrinho ({items.length})</h3>
          
          {items.length === 0 ? (
            <div className="empty-cart">
              <FiShoppingCart size={48} />
              <p>Carrinho vazio</p>
              <small>Adicione produtos acima</small>
            </div>
          ) : (
            <div className="items-list">
              {items.map((item, index) => (
                <div key={index} className="cart-item">
                  <div className="item-info">
                    <div className="item-sku">
                      <strong>SKU:</strong> {item.product_retailer_id}
                    </div>
                    <div className="item-price">
                      R$ {item.item_price.toFixed(2)} × {item.quantity}
                    </div>
                  </div>

                  <div className="item-controls">
                    <div className="quantity-controls">
                      <button 
                        onClick={() => handleUpdateQuantity(index, -1)}
                        disabled={item.quantity <= 1}
                      >
                        <FiMinus />
                      </button>
                      <span>{item.quantity}</span>
                      <button onClick={() => handleUpdateQuantity(index, 1)}>
                        <FiPlus />
                      </button>
                    </div>

                    <div className="item-total">
                      R$ {(item.item_price * item.quantity).toFixed(2)}
                    </div>

                    <button 
                      className="btn-remove"
                      onClick={() => handleRemoveItem(index)}
                    >
                      <FiTrash2 />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Total and Send */}
        <div className="cart-footer">
          <div className="cart-total">
            <span>Total:</span>
            <strong>R$ {calculateTotal().toFixed(2)}</strong>
          </div>

          <button 
            className="btn-send-cart"
            onClick={handleSend}
            disabled={sending || items.length === 0 || !catalogId.trim()}
          >
            {sending ? (
              'Enviando...'
            ) : (
              <>
                <FiSend /> Enviar Carrinho
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CartBuilder;
