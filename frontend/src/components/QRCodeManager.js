/**
 * QRCodeManager.js — REDESENHADO
 * 
 * Gerencia QR Codes de MARKETING da Meta WhatsApp Business API.
 * Acessível pelo menu lateral (⋮).
 * 
 * DIFERENTE do SessionQRCode (que autentica sessão WhatsApp Web).
 * Este cria links QR com mensagem pré-preenchida para clientes escanearem
 * e iniciarem uma conversa com o negócio.
 * 
 * Ex: QR no balcão de uma loja → cliente escaneia → abre WhatsApp
 *     com "Olá! Vim pelo display da loja" já digitado.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  MdClose, MdQrCode, MdDelete, MdEdit, MdAdd,
  MdContentCopy, MdDownload, MdCheck, MdRefresh,
  MdInfoOutline,
} from 'react-icons/md';
import apiService from '../services/api';
import '../styles/QRCodeManager.css';


const QRCodeManager = ({ onClose }) => {
  const [qrCodes, setQrCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingCode, setEditingCode] = useState(null); // code string sendo editado
  const [formData, setFormData] = useState({ message: '', image_format: 'PNG' });
  const [saving, setSaving] = useState(false);
  const [copiedCode, setCopiedCode] = useState(null); // feedback de cópia
  const [deletingCode, setDeletingCode] = useState(null);

  // ── Data ─────────────────────────────────────────────

  const loadQRCodes = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiService.listQRCodes();
      setQrCodes(data?.qr_codes || data || []);
    } catch (err) {
      console.error('Erro ao carregar QR Codes:', err);
      setQrCodes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQRCodes();
  }, [loadQRCodes]);

  // ── CRUD ─────────────────────────────────────────────

  const handleCreate = async () => {
    if (!formData.message.trim()) return;
    setSaving(true);
    try {
      if (editingCode) {
        await apiService.updateQRCode(editingCode, formData.message);
      } else {
        await apiService.createQRCode(formData.message, formData.image_format);
      }
      setShowCreate(false);
      setEditingCode(null);
      setFormData({ message: '', image_format: 'PNG' });
      await loadQRCodes();
    } catch (err) {
      console.error('Erro ao salvar QR Code:', err);
      alert('Erro ao salvar QR Code. Verifique a API e tente novamente.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (code) => {
    if (!window.confirm('Deletar este QR Code permanentemente?')) return;
    setDeletingCode(code);
    try {
      await apiService.deleteQRCode(code);
      await loadQRCodes();
    } catch (err) {
      console.error('Erro ao deletar QR Code:', err);
    } finally {
      setDeletingCode(null);
    }
  };

  const handleEdit = (qr) => {
    setEditingCode(qr.code);
    setFormData({ message: qr.prefilled_message || '', image_format: 'PNG' });
    setShowCreate(true);
  };

  const handleCancelForm = () => {
    setShowCreate(false);
    setEditingCode(null);
    setFormData({ message: '', image_format: 'PNG' });
  };

  // ── Ações de QR ──────────────────────────────────────

  const handleCopyLink = async (qr) => {
    const link = qr.deep_link_url || qr.qr_image_url || '';
    try {
      await navigator.clipboard.writeText(link);
      setCopiedCode(qr.code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch {
      alert(`Link: ${link}`);
    }
  };

  const handleDownload = (qr) => {
    const url = qr.qr_image_url;
    if (!url) { alert('URL da imagem não disponível'); return; }
    const a = document.createElement('a');
    a.href = url;
    a.download = `qrcode-${qr.code}.png`;
    a.click();
  };

  // ── Helpers ──────────────────────────────────────────

  const formatDate = (dateStr) => {
    if (!dateStr) return '—';
    try {
      return new Date(dateStr).toLocaleDateString('pt-BR', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
    } catch { return '—'; }
  };

  const truncate = (str, n = 60) =>
    str && str.length > n ? str.slice(0, n) + '…' : str;

  // ── Render ───────────────────────────────────────────

  return (
    <div className="qrm-overlay" onClick={onClose}>
      <div className="qrm-modal" onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="qrm-header">
          <div className="qrm-header-left">
            <div className="qrm-header-icon">
              <MdQrCode size={20} />
            </div>
            <div>
              <h2 className="qrm-title">QR Codes de Marketing</h2>
              <p className="qrm-subtitle">
                Links WhatsApp com mensagem pré-preenchida para clientes
              </p>
            </div>
          </div>
          <button className="qrm-close" onClick={onClose} title="Fechar">
            <MdClose size={20} />
          </button>
        </div>

        {/* ── Info box ── */}
        <div className="qrm-info-box">
          <MdInfoOutline size={14} />
          <span>
            Estes QR codes direcionam clientes para uma conversa no WhatsApp com
            uma mensagem já digitada. Ideal para exibir em lojas, cardápios ou materiais
            de marketing.
          </span>
        </div>

        {/* ── Body ── */}
        <div className="qrm-body">

          {/* Botão de criar */}
          {!showCreate && (
            <button className="qrm-btn-create" onClick={() => setShowCreate(true)}>
              <MdAdd size={18} />
              Criar novo QR Code
            </button>
          )}

          {/* Formulário de criar/editar */}
          {showCreate && (
            <div className="qrm-form">
              <div className="qrm-form-header">
                <h3>{editingCode ? 'Editar QR Code' : 'Novo QR Code'}</h3>
              </div>

              <div className="qrm-field">
                <label>Mensagem pré-preenchida *</label>
                <textarea
                  rows={3}
                  placeholder="Ex: Olá! Vim pelo display da loja e gostaria de saber mais sobre os produtos."
                  value={formData.message}
                  onChange={e => setFormData({ ...formData, message: e.target.value })}
                  maxLength={512}
                />
                <span className="qrm-char-count">{formData.message.length}/512</span>
              </div>

              {!editingCode && (
                <div className="qrm-field">
                  <label>Formato da imagem</label>
                  <select
                    value={formData.image_format}
                    onChange={e => setFormData({ ...formData, image_format: e.target.value })}
                  >
                    <option value="PNG">PNG (recomendado)</option>
                    <option value="SVG">SVG (vetorial)</option>
                  </select>
                </div>
              )}

              <div className="qrm-form-actions">
                <button className="qrm-btn-cancel" onClick={handleCancelForm}>
                  Cancelar
                </button>
                <button
                  className="qrm-btn-save"
                  onClick={handleCreate}
                  disabled={saving || !formData.message.trim()}
                >
                  {saving ? (
                    <>
                      <span className="qrm-saving-dot" />
                      Salvando...
                    </>
                  ) : (
                    <>
                      {editingCode ? <MdEdit size={15} /> : <MdAdd size={15} />}
                      {editingCode ? 'Salvar alterações' : 'Criar QR Code'}
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Lista de QR Codes */}
          <div className="qrm-list">
            {loading ? (
              <div className="qrm-empty">
                <div className="qrm-spinner" />
                <span>Carregando...</span>
              </div>
            ) : qrCodes.length === 0 ? (
              <div className="qrm-empty">
                <MdQrCode size={36} className="qrm-empty-icon" />
                <p>Nenhum QR Code criado ainda</p>
                <span>Crie o primeiro para começar</span>
              </div>
            ) : (
              qrCodes.map(qr => (
                <div key={qr.code} className="qrm-card">
                  {/* Preview do QR */}
                  <div className="qrm-card-qr">
                    {qr.qr_image_url ? (
                      <img
                        src={qr.qr_image_url}
                        alt="QR Code"
                        className="qrm-card-qr-img"
                      />
                    ) : (
                      <div className="qrm-card-qr-placeholder">
                        <MdQrCode size={32} />
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="qrm-card-info">
                    <div className="qrm-card-code">{qr.code}</div>
                    <div className="qrm-card-message">
                      {truncate(qr.prefilled_message)}
                    </div>
                    <div className="qrm-card-meta">
                      Criado em {formatDate(qr.created_at)}
                    </div>
                  </div>

                  {/* Ações */}
                  <div className="qrm-card-actions">
                    <button
                      className="qrm-action-btn"
                      onClick={() => handleCopyLink(qr)}
                      title="Copiar link"
                    >
                      {copiedCode === qr.code
                        ? <MdCheck size={16} style={{ color: '#2FAE60' }} />
                        : <MdContentCopy size={16} />
                      }
                    </button>
                    <button
                      className="qrm-action-btn"
                      onClick={() => handleDownload(qr)}
                      title="Baixar imagem"
                    >
                      <MdDownload size={16} />
                    </button>
                    <button
                      className="qrm-action-btn"
                      onClick={() => handleEdit(qr)}
                      title="Editar mensagem"
                    >
                      <MdEdit size={16} />
                    </button>
                    <button
                      className="qrm-action-btn qrm-action-delete"
                      onClick={() => handleDelete(qr.code)}
                      title="Deletar"
                      disabled={deletingCode === qr.code}
                    >
                      {deletingCode === qr.code
                        ? <span className="qrm-saving-dot" />
                        : <MdDelete size={16} />
                      }
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Botão de reload */}
          {!loading && qrCodes.length > 0 && (
            <button className="qrm-btn-reload" onClick={loadQRCodes}>
              <MdRefresh size={14} />
              Atualizar lista
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default QRCodeManager;
