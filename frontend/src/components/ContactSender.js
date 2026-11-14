/**
 * ContactSender Component
 * 
 * Enviar contatos vCard
 * Múltiplos telefones e emails
 * Endereços completos
 * Informações organizacionais
 * Preview do vCard
 */
import React, { useState, useEffect } from 'react';
import { MdClose, MdSend, MdPerson, MdPhone, MdEmail, MdLocationOn, MdBusiness, MdBookmark, MdBookmarkBorder } from 'react-icons/md';
import { BsPersonVcard, BsPlus, BsTrash } from 'react-icons/bs';
import apiService, { api } from '../services/api';
import { getRecipientJid } from '../utils/recipient';
import '../styles/ContactSender.css';

const emptyContact = () => ({
  name: {
    formatted_name: '',
    first_name: '',
    last_name: '',
    middle_name: '',
    suffix: '',
    prefix: ''
  },
  phones: [{ phone: '', type: 'CELL', wa_id: '' }],
  emails: [{ email: '', type: 'WORK' }],
  org: {
    company: '',
    department: '',
    title: ''
  },
  addresses: [],
  urls: [],
  birthday: ''
});

const ContactSender = ({ conversation, onClose, onSent }) => {
  const [contact, setContact] = useState(emptyContact());

  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  // Agenda pessoal — evita redigitar o mesmo contato toda vez.
  const [savedContacts, setSavedContacts] = useState([]);
  const [selectedSavedId, setSelectedSavedId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiService.getSavedContacts().then(setSavedContacts);
  }, []);

  const applySavedContact = (id) => {
    setSelectedSavedId(id);
    if (!id) return;
    const saved = savedContacts.find(c => String(c.id) === String(id));
    if (!saved) return;
    // Merge com o formato vazio — um contato salvo antes de algum campo
    // novo existir (ex: urls) não pode deixar o formulário sem esse array.
    setContact({ ...emptyContact(), ...saved.contact_data });
  };

  const handleSaveContact = async () => {
    if (!isValid()) {
      setError('Preencha pelo menos o nome e um telefone antes de salvar');
      return;
    }
    try {
      setSaving(true);
      const cleaned = {
        name: contact.name,
        phones: contact.phones.filter(p => p.phone.trim() !== ''),
        emails: contact.emails.filter(e => e.email.trim() !== ''),
        org: contact.org,
        addresses: contact.addresses,
        urls: contact.urls.filter(u => u.trim() !== ''),
        birthday: contact.birthday
      };
      const result = await apiService.saveContact(contact.name.formatted_name.trim(), cleaned);
      if (result?.success) {
        setSavedContacts(prev => [...prev, result.data].sort((a, b) => a.display_name.localeCompare(b.display_name)));
        setSelectedSavedId(String(result.data.id));
      }
    } catch (err) {
      console.error('Erro ao salvar contato:', err);
      setError(err.response?.data?.detail || 'Erro ao salvar contato na agenda');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSavedContact = async (id) => {
    try {
      await apiService.deleteSavedContact(id);
      setSavedContacts(prev => prev.filter(c => c.id !== id));
      if (String(selectedSavedId) === String(id)) setSelectedSavedId('');
    } catch (err) {
      console.error('Erro ao remover contato salvo:', err);
    }
  };

  // Adicionar telefone
  const addPhone = () => {
    setContact(prev => ({
      ...prev,
      phones: [...prev.phones, { phone: '', type: 'CELL', wa_id: '' }]
    }));
  };

  // Remover telefone
  const removePhone = (index) => {
    setContact(prev => ({
      ...prev,
      phones: prev.phones.filter((_, i) => i !== index)
    }));
  };

  // Atualizar telefone
  const updatePhone = (index, field, value) => {
    setContact(prev => ({
      ...prev,
      phones: prev.phones.map((phone, i) => 
        i === index ? { ...phone, [field]: value } : phone
      )
    }));
  };

  // Adicionar email
  const addEmail = () => {
    setContact(prev => ({
      ...prev,
      emails: [...prev.emails, { email: '', type: 'WORK' }]
    }));
  };

  // Remover email
  const removeEmail = (index) => {
    setContact(prev => ({
      ...prev,
      emails: prev.emails.filter((_, i) => i !== index)
    }));
  };

  // Atualizar email
  const updateEmail = (index, field, value) => {
    setContact(prev => ({
      ...prev,
      emails: prev.emails.map((email, i) => 
        i === index ? { ...email, [field]: value } : email
      )
    }));
  };

  // Adicionar endereço
  const addAddress = () => {
    setContact(prev => ({
      ...prev,
      addresses: [...prev.addresses, {
        street: '',
        city: '',
        state: '',
        zip: '',
        country: '',
        country_code: '',
        type: 'HOME'
      }]
    }));
  };

  // Remover endereço
  const removeAddress = (index) => {
    setContact(prev => ({
      ...prev,
      addresses: prev.addresses.filter((_, i) => i !== index)
    }));
  };

  // Atualizar endereço
  const updateAddress = (index, field, value) => {
    setContact(prev => ({
      ...prev,
      addresses: prev.addresses.map((addr, i) => 
        i === index ? { ...addr, [field]: value } : addr
      )
    }));
  };

  // Atualizar nome
  const updateName = (field, value) => {
    setContact(prev => ({
      ...prev,
      name: { ...prev.name, [field]: value }
    }));
  };

  // Atualizar organização
  const updateOrg = (field, value) => {
    setContact(prev => ({
      ...prev,
      org: { ...prev.org, [field]: value }
    }));
  };

  // Validar contato
  const isValid = () => {
    if (!contact.name.formatted_name.trim()) return false;
    if (contact.phones.length === 0) return false;
    const hasValidPhone = contact.phones.some(p => p.phone.trim() !== '');
    return hasValidPhone;
  };

  // Enviar contato
  const handleSend = async () => {
    if (!isValid()) {
      setError('Preencha pelo menos o nome e um telefone');
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
      const cleanedContact = {
        name: contact.name,
        phones: contact.phones.filter(p => p.phone.trim() !== ''),
        emails: contact.emails.filter(e => e.email.trim() !== ''),
        org: contact.org,
        addresses: contact.addresses,
        urls: contact.urls.filter(u => u.trim() !== ''),
        birthday: contact.birthday
      };

      const response = await api.post('/api/send/contacts', {
        to: getRecipientJid(conversation),
        contacts: [cleanedContact],
        account_id: conversation.account_id || null
      });

      console.log('Contato enviado:', response.data);
      setSuccess(true);
      // O envio salva a mensagem no banco mas o backend só emite
      // broadcast_conversation_meta_update (reordena a lista), não
      // broadcast_new_message — sem isso o contato enviado só apareceria no
      // chat depois de trocar de conversa e voltar. onSent() recarrega as
      // mensagens da conversa atual pra mostrar na hora.
      onSent?.();

      setTimeout(() => {
        onClose();
      }, 2000);

    } catch (err) {
      console.error('Erro ao enviar contato:', err);
      setError(err.response?.data?.detail || 'Erro ao enviar contato');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="contact-sender-overlay" onClick={onClose}>
      <div className="contact-sender-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="contact-sender-header">
          <div className="contact-sender-title">
            <BsPersonVcard size={24} />
            <h2>Enviar Contato</h2>
          </div>
          <button className="contact-sender-close" onClick={onClose}>
            <MdClose size={24} />
          </button>
        </div>

        {/* Body */}
        <div className="contact-sender-body">
          {/* Agenda pessoal */}
          {savedContacts.length > 0 && (
            <div className="contact-section">
              <div className="section-header">
                <MdBookmark size={20} />
                <h3>Contatos salvos</h3>
              </div>
              <div className="saved-contact-picker">
                <select
                  value={selectedSavedId}
                  onChange={(e) => applySavedContact(e.target.value)}
                >
                  <option value="">Preencher a partir de um contato salvo...</option>
                  {savedContacts.map(c => (
                    <option key={c.id} value={c.id}>{c.display_name}</option>
                  ))}
                </select>
                {selectedSavedId && (
                  <button
                    className="btn-remove-item saved-contact-delete"
                    title="Remover da agenda"
                    onClick={() => handleDeleteSavedContact(Number(selectedSavedId))}
                  >
                    <BsTrash />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Nome */}
          <div className="contact-section">
            <div className="section-header">
              <MdPerson size={20} />
              <h3>Informações Pessoais</h3>
            </div>

            <div className="contact-field">
              <label>Nome Completo *</label>
              <input
                type="text"
                placeholder="Ex: João da Silva"
                value={contact.name.formatted_name}
                onChange={(e) => updateName('formatted_name', e.target.value)}
              />
            </div>

            <div className="contact-grid">
              <div className="contact-field">
                <label>Primeiro Nome</label>
                <input
                  type="text"
                  placeholder="João"
                  value={contact.name.first_name}
                  onChange={(e) => updateName('first_name', e.target.value)}
                />
              </div>
              <div className="contact-field">
                <label>Sobrenome</label>
                <input
                  type="text"
                  placeholder="Silva"
                  value={contact.name.last_name}
                  onChange={(e) => updateName('last_name', e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Telefones */}
          <div className="contact-section">
            <div className="section-header">
              <MdPhone size={20} />
              <h3>Telefones *</h3>
            </div>

            {contact.phones.map((phone, index) => (
              <div key={index} className="phone-item">
                <div className="contact-grid">
                  <div className="contact-field">
                    <input
                      type="tel"
                      placeholder="(00) 00000-0000"
                      value={phone.phone}
                      onChange={(e) => updatePhone(index, 'phone', e.target.value)}
                    />
                  </div>
                  <div className="contact-field">
                    <select
                      value={phone.type}
                      onChange={(e) => updatePhone(index, 'type', e.target.value)}
                    >
                      <option value="CELL">Celular</option>
                      <option value="HOME">Residencial</option>
                      <option value="WORK">Trabalho</option>
                    </select>
                  </div>
                </div>
                {contact.phones.length > 1 && (
                  <button
                    className="btn-remove-item"
                    onClick={() => removePhone(index)}
                  >
                    <BsTrash />
                  </button>
                )}
              </div>
            ))}

            <button className="btn-add-item" onClick={addPhone}>
              <BsPlus /> Adicionar Telefone
            </button>
          </div>

          {/* Emails */}
          <div className="contact-section">
            <div className="section-header">
              <MdEmail size={20} />
              <h3>Emails</h3>
            </div>

            {contact.emails.map((email, index) => (
              <div key={index} className="email-item">
                <div className="contact-grid">
                  <div className="contact-field">
                    <input
                      type="email"
                      placeholder="email@exemplo.com"
                      value={email.email}
                      onChange={(e) => updateEmail(index, 'email', e.target.value)}
                    />
                  </div>
                  <div className="contact-field">
                    <select
                      value={email.type}
                      onChange={(e) => updateEmail(index, 'type', e.target.value)}
                    >
                      <option value="WORK">Trabalho</option>
                      <option value="HOME">Pessoal</option>
                    </select>
                  </div>
                </div>
                {contact.emails.length > 1 && (
                  <button
                    className="btn-remove-item"
                    onClick={() => removeEmail(index)}
                  >
                    <BsTrash />
                  </button>
                )}
              </div>
            ))}

            <button className="btn-add-item" onClick={addEmail}>
              <BsPlus /> Adicionar Email
            </button>
          </div>

          {/* Organização */}
          <div className="contact-section">
            <div className="section-header">
              <MdBusiness size={20} />
              <h3>Organização</h3>
            </div>

            <div className="contact-grid">
              <div className="contact-field">
                <label>Empresa</label>
                <input
                  type="text"
                  placeholder="Nome da Empresa"
                  value={contact.org.company}
                  onChange={(e) => updateOrg('company', e.target.value)}
                />
              </div>
              <div className="contact-field">
                <label>Departamento</label>
                <input
                  type="text"
                  placeholder="Ex: Vendas"
                  value={contact.org.department}
                  onChange={(e) => updateOrg('department', e.target.value)}
                />
              </div>
            </div>

            <div className="contact-field">
              <label>Cargo</label>
              <input
                type="text"
                placeholder="Ex: Gerente de Vendas"
                value={contact.org.title}
                onChange={(e) => updateOrg('title', e.target.value)}
              />
            </div>
          </div>

          {/* Endereços */}
          {contact.addresses.length > 0 && (
            <div className="contact-section">
              <div className="section-header">
                <MdLocationOn size={20} />
                <h3>Endereços</h3>
              </div>

              {contact.addresses.map((address, index) => (
                <div key={index} className="address-item">
                  <div className="contact-field">
                    <label>Rua</label>
                    <input
                      type="text"
                      placeholder="Ex: Av. Paulista, 1000"
                      value={address.street}
                      onChange={(e) => updateAddress(index, 'street', e.target.value)}
                    />
                  </div>

                  <div className="contact-grid">
                    <div className="contact-field">
                      <label>Cidade</label>
                      <input
                        type="text"
                        placeholder="São Paulo"
                        value={address.city}
                        onChange={(e) => updateAddress(index, 'city', e.target.value)}
                      />
                    </div>
                    <div className="contact-field">
                      <label>Estado</label>
                      <input
                        type="text"
                        placeholder="SP"
                        value={address.state}
                        onChange={(e) => updateAddress(index, 'state', e.target.value)}
                      />
                    </div>
                  </div>

                  <button
                    className="btn-remove-item"
                    onClick={() => removeAddress(index)}
                  >
                    <BsTrash /> Remover Endereço
                  </button>
                </div>
              ))}
            </div>
          )}

          <button className="btn-add-section" onClick={addAddress}>
            <MdLocationOn /> Adicionar Endereço
          </button>

          {/* Messages */}
          {error && (
            <div className="contact-sender-error">
              ⚠️ {error}
            </div>
          )}

          {success && (
            <div className="contact-sender-success">
              Contato enviado com sucesso!
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="contact-sender-footer">
          <button className="btn-cancel" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn-save-contact"
            onClick={handleSaveContact}
            disabled={!isValid() || saving}
            title="Salvar na agenda pessoal, pra reusar depois sem redigitar"
          >
            {saving ? <div className="spinner"></div> : <MdBookmarkBorder />}
            Salvar na agenda
          </button>
          <button
            className="btn-send-contact"
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
                Enviar Contato
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ContactSender;
