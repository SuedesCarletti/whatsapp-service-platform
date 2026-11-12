/**
 * CatalogManager.js
 *
 * CRUD de produtos de um catálogo do Facebook já existente, direto na
 * aplicação (sem abrir o Commerce Manager). Não cria catálogos novos —
 * o ID do catálogo é colado uma vez (fica salvo na conta) e os produtos
 * são gerenciados a partir daí.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { MdAdd, MdDelete, MdEdit, MdClose, MdSave, MdRefresh, MdInfoOutline } from 'react-icons/md';
import apiService from '../services/api';
import '../styles/CatalogManager.css';

const AVAILABILITY_OPTIONS = ['in stock', 'out of stock', 'preorder', 'available for order', 'discontinued'];
const CONDITION_OPTIONS = ['new', 'refurbished', 'used'];

const emptyProduct = () => ({
  retailer_id: '', name: '', description: '', price: '', currency: 'BRL',
  image_url: '', url: '', availability: 'in stock', condition: 'new', brand: '',
});

const CatalogManager = () => {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(null);
  const [catalogId, setCatalogId] = useState('');
  const [catalogIdSaved, setCatalogIdSaved] = useState('');
  const [savingCatalogId, setSavingCatalogId] = useState(false);

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyProduct());
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  useEffect(() => {
    (async () => {
      const all = await apiService.getAccounts();
      const metaAccounts = (all || []).filter(a => (a.provider_type || '').startsWith('meta'));
      setAccounts(metaAccounts);
      if (metaAccounts.length > 0) {
        setAccountId(metaAccounts[0].id);
        setCatalogId(metaAccounts[0].meta_catalog_id || '');
        setCatalogIdSaved(metaAccounts[0].meta_catalog_id || '');
      }
    })();
  }, []);

  useEffect(() => {
    const acc = accounts.find(a => a.id === accountId);
    if (acc) {
      setCatalogId(acc.meta_catalog_id || '');
      setCatalogIdSaved(acc.meta_catalog_id || '');
    }
  }, [accountId, accounts]);

  const loadProducts = useCallback(async () => {
    if (!catalogIdSaved) { setProducts([]); return; }
    setLoading(true);
    try {
      const res = await apiService.getCatalogProducts(accountId);
      setProducts(res.data || []);
    } catch (e) {
      console.error('Erro ao carregar produtos:', e);
    } finally {
      setLoading(false);
    }
  }, [accountId, catalogIdSaved]);

  useEffect(() => { loadProducts(); }, [loadProducts]);

  const handleSaveCatalogId = async () => {
    if (!accountId) return;
    setSavingCatalogId(true);
    try {
      await apiService.updateAccount(accountId, { meta_catalog_id: catalogId.trim() });
      setCatalogIdSaved(catalogId.trim());
      setAccounts(prev => prev.map(a => (a.id === accountId ? { ...a, meta_catalog_id: catalogId.trim() } : a)));
    } catch (e) {
      alert(e?.response?.data?.detail || 'Erro ao salvar Catalog ID');
    } finally {
      setSavingCatalogId(false);
    }
  };

  const openNewForm = () => {
    setForm(emptyProduct());
    setEditingId(null);
    setFormError('');
    setShowForm(true);
  };

  const openEditForm = (p) => {
    setForm({
      retailer_id: p.retailer_id || '',
      name: p.name || '',
      description: p.description || '',
      price: p.price ? String(p.price).replace(/[^\d.,]/g, '').replace(',', '.') : '',
      currency: (p.currency || 'BRL'),
      image_url: p.image_url || '',
      url: p.url || '',
      availability: p.availability || 'in stock',
      condition: p.condition || 'new',
      brand: p.brand || '',
    });
    setEditingId(p.id);
    setFormError('');
    setShowForm(true);
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Excluir esse produto do catálogo?')) return;
    setDeletingId(id);
    try {
      await apiService.deleteCatalogProduct(id, accountId);
      await loadProducts();
    } catch (e) {
      alert(e?.response?.data?.detail || 'Erro ao excluir produto');
    } finally {
      setDeletingId(null);
    }
  };

  const handleSubmit = async () => {
    if (!form.retailer_id.trim() || !form.name.trim() || !form.image_url.trim() || !form.price) {
      setFormError('Preencha ID (SKU), nome, preço e URL da imagem.');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      const price = parseFloat(String(form.price).replace(',', '.'));
      if (editingId) {
        await apiService.updateCatalogProduct(editingId, {
          name: form.name, description: form.description, price,
          currency: form.currency, image_url: form.image_url, url: form.url || undefined,
          availability: form.availability, condition: form.condition, brand: form.brand || undefined,
        }, accountId);
      } else {
        await apiService.createCatalogProduct({
          retailer_id: form.retailer_id, name: form.name, description: form.description,
          price, currency: form.currency, image_url: form.image_url, url: form.url || undefined,
          availability: form.availability, condition: form.condition, brand: form.brand || undefined,
        }, accountId);
      }
      setShowForm(false);
      await loadProducts();
    } catch (e) {
      setFormError(e?.response?.data?.detail || 'Erro ao salvar produto');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="cm-container">
      <div className="cm-catalog-config">
        {accounts.length > 1 && (
          <select className="cm-select" value={accountId || ''} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number || `Conta #${a.id}`}</option>)}
          </select>
        )}
        <input
          type="text"
          className="cm-catalog-input"
          placeholder="Catalog ID (Commerce Manager)"
          value={catalogId}
          onChange={(e) => setCatalogId(e.target.value)}
        />
        <button className="cm-btn cm-btn-ghost" onClick={handleSaveCatalogId} disabled={savingCatalogId || catalogId === catalogIdSaved}>
          <MdSave size={16} /> Salvar
        </button>
        {catalogIdSaved && (
          <button className="cm-btn cm-btn-ghost" onClick={loadProducts}>
            <MdRefresh size={16} /> Atualizar
          </button>
        )}
      </div>

      {!catalogIdSaved ? (
        <div className="cm-note">
          <MdInfoOutline size={16} /> Cole o ID do catálogo (criado no Commerce Manager da Meta) acima e clique em Salvar
          para começar a gerenciar os produtos por aqui.
        </div>
      ) : (
        <>
          <div className="cm-toolbar">
            <span className="cm-count">{products.length} produto(s)</span>
            <button className="cm-btn cm-btn-primary" onClick={openNewForm}>
              <MdAdd size={18} /> Novo Produto
            </button>
          </div>

          {loading ? (
            <div className="cm-empty">Carregando produtos...</div>
          ) : products.length === 0 ? (
            <div className="cm-empty">Nenhum produto neste catálogo ainda.</div>
          ) : (
            <div className="cm-grid">
              {products.map(p => (
                <div key={p.id} className="cm-product-card">
                  <div className="cm-product-image" style={{ backgroundImage: `url(${p.image_url})` }} />
                  <div className="cm-product-info">
                    <div className="cm-product-name">{p.name}</div>
                    <div className="cm-product-price">{p.price}</div>
                    <div className="cm-product-sku">SKU: {p.retailer_id}</div>
                    <span className={`cm-avail cm-avail-${(p.availability || '').replace(/\s+/g, '-')}`}>
                      {p.availability}
                    </span>
                  </div>
                  <div className="cm-product-actions">
                    <button className="cm-icon-btn" onClick={() => openEditForm(p)} title="Editar">
                      <MdEdit size={16} />
                    </button>
                    <button
                      className="cm-icon-btn cm-icon-btn-danger"
                      onClick={() => handleDelete(p.id)}
                      disabled={deletingId === p.id}
                      title="Excluir"
                    >
                      <MdDelete size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {showForm && (
        <div className="cm-form-overlay" onClick={(e) => e.target === e.currentTarget && setShowForm(false)}>
          <div className="cm-form-modal">
            <div className="cm-form-header">
              <h3>{editingId ? 'Editar Produto' : 'Novo Produto'}</h3>
              <button className="cm-icon-btn" onClick={() => setShowForm(false)}><MdClose size={20} /></button>
            </div>
            <div className="cm-form-body">
              {formError && <div className="cm-form-error">⚠️ {formError}</div>}

              <div className="cm-form-row">
                <label>SKU (retailer_id) {editingId && '— não pode ser alterado'}</label>
                <input type="text" value={form.retailer_id} disabled={!!editingId}
                  onChange={(e) => setForm(f => ({ ...f, retailer_id: e.target.value }))} />
              </div>
              <div className="cm-form-row">
                <label>Nome</label>
                <input type="text" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="cm-form-row">
                <label>Descrição</label>
                <textarea rows={3} value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} />
              </div>
              <div className="cm-form-row-split">
                <div className="cm-form-row">
                  <label>Preço</label>
                  <input type="text" placeholder="29.90" value={form.price} onChange={(e) => setForm(f => ({ ...f, price: e.target.value }))} />
                </div>
                <div className="cm-form-row">
                  <label>Moeda</label>
                  <input type="text" value={form.currency} onChange={(e) => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} />
                </div>
              </div>
              <div className="cm-form-row">
                <label>URL da imagem</label>
                <input type="text" placeholder="https://..." value={form.image_url} onChange={(e) => setForm(f => ({ ...f, image_url: e.target.value }))} />
              </div>
              <div className="cm-form-row">
                <label>URL do produto (opcional)</label>
                <input type="text" placeholder="https://..." value={form.url} onChange={(e) => setForm(f => ({ ...f, url: e.target.value }))} />
              </div>
              <div className="cm-form-row-split">
                <div className="cm-form-row">
                  <label>Disponibilidade</label>
                  <select value={form.availability} onChange={(e) => setForm(f => ({ ...f, availability: e.target.value }))}>
                    {AVAILABILITY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className="cm-form-row">
                  <label>Condição</label>
                  <select value={form.condition} onChange={(e) => setForm(f => ({ ...f, condition: e.target.value }))}>
                    {CONDITION_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              </div>
              <div className="cm-form-row">
                <label>Marca (opcional)</label>
                <input type="text" value={form.brand} onChange={(e) => setForm(f => ({ ...f, brand: e.target.value }))} />
              </div>
            </div>
            <div className="cm-form-footer">
              <button className="cm-btn cm-btn-ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button className="cm-btn cm-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Salvando...' : (editingId ? 'Salvar alterações' : 'Criar Produto')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CatalogManager;
