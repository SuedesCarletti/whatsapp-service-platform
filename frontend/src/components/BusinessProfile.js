/**
 * BusinessProfile Component - Editor de Perfil do Negócio
 * 
 * Permite visualizar e editar informações do perfil do WhatsApp Business
 */
import React, { useState, useEffect } from 'react';
import { MdClose, MdSave, MdBusiness } from 'react-icons/md';
import { BsBuilding } from 'react-icons/bs';
import { api } from '../services/api';
import '../styles/BusinessProfile.css';

const BusinessProfile = ({ onClose }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  
  // Dados do perfil
  const [profile, setProfile] = useState({
    about: '',
    address: '',
    description: '',
    email: '',
    vertical: '',
    websites: []
  });

  // Dados originais (para detectar mudanças)
  const [originalProfile, setOriginalProfile] = useState(null);

  // Categorias disponíveis
  const verticals = [
    { value: 'AUTOMOTIVE', label: 'Automotivo' },
    { value: 'BEAUTY', label: 'Beleza e Estética' },
    { value: 'APPAREL', label: 'Vestuário e Moda' },
    { value: 'EDU', label: 'Educação' },
    { value: 'ENTERTAIN', label: 'Entretenimento' },
    { value: 'EVENT_PLAN', label: 'Planejamento de Eventos' },
    { value: 'FINANCE', label: 'Finanças' },
    { value: 'GROCERY', label: 'Supermercado' },
    { value: 'GOVT', label: 'Governo' },
    { value: 'HOTEL', label: 'Hotel e Hospedagem' },
    { value: 'HEALTH', label: 'Saúde' },
    { value: 'NONPROFIT', label: 'Sem Fins Lucrativos' },
    { value: 'PROF_SERVICES', label: 'Serviços Profissionais' },
    { value: 'RETAIL', label: 'Varejo' },
    { value: 'TRAVEL', label: 'Viagens e Turismo' },
    { value: 'RESTAURANT', label: 'Restaurante' },
    { value: 'NOT_A_BIZ', label: 'Não é um Negócio' }
  ];

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      setLoading(true);
      setError(null);
  
      const response = await api.get('/api/extended/business/profile');

      // O backend devolve o perfil direto no corpo (sem wrapper "data" extra)
      if (!response.data) {
        throw new Error('Resposta da API inválida');
      }

      const data = response.data;
      
      const profileData = {
        about: data?.about || '',
        address: data?.address || '',
        description: data?.description || '',
        email: data?.email || '',
        vertical: data?.vertical || '',
        websites: data?.websites || []
      };
  
      setProfile(profileData);
      setOriginalProfile(profileData);
  
    } catch (err) {
      console.error('Erro ao carregar perfil:', err);
      setError(err.response?.data?.detail || err.message || 'Erro ao carregar perfil');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      // Montar payload apenas com campos que mudaram
      const updates = {};
      
      if (profile.about !== originalProfile.about) {
        updates.about = profile.about;
      }
      if (profile.address !== originalProfile.address) {
        updates.address = profile.address;
      }
      if (profile.description !== originalProfile.description) {
        updates.description = profile.description;
      }
      if (profile.email !== originalProfile.email) {
        updates.email = profile.email;
      }
      if (profile.vertical !== originalProfile.vertical) {
        updates.vertical = profile.vertical;
      }
      if (JSON.stringify(profile.websites) !== JSON.stringify(originalProfile.websites)) {
        updates.websites = profile.websites.filter(w => w.trim() !== '');
      }

      if (Object.keys(updates).length === 0) {
        setError('Nenhuma alteração detectada');
        setSaving(false);
        return;
      }

      await api.patch('/api/extended/business/profile', updates);

      console.log('Perfil atualizado com sucesso');
      setSuccess(true);
      setOriginalProfile(profile);

      setTimeout(() => {
        setSuccess(false);
      }, 3000);

    } catch (err) {
      console.error('Erro ao salvar perfil:', err);
      setError(err.response?.data?.detail || 'Erro ao salvar perfil');
    } finally {
      setSaving(false);
    }
  };

  const handleWebsiteChange = (index, value) => {
    const newWebsites = [...profile.websites];
    newWebsites[index] = value;
    setProfile({ ...profile, websites: newWebsites });
  };

  const addWebsite = () => {
    if (profile.websites.length < 2) {
      setProfile({ ...profile, websites: [...profile.websites, ''] });
    }
  };

  const removeWebsite = (index) => {
    const newWebsites = profile.websites.filter((_, i) => i !== index);
    setProfile({ ...profile, websites: newWebsites });
  };

  const hasChanges = originalProfile && JSON.stringify(profile) !== JSON.stringify(originalProfile);

  return (
    <div className="business-profile-overlay" onClick={onClose}>
      <div className="business-profile-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="business-profile-header">
          <div className="business-profile-title">
            <BsBuilding size={24} />
            <h2>Perfil do Negócio</h2>
          </div>
          <button className="business-profile-close" onClick={onClose}>
            <MdClose size={24} />
          </button>
        </div>

        {/* Body */}
        <div className="business-profile-body">
          {loading && (
            <div className="business-profile-loading">
              <div className="business-profile-spinner" />
              <p>Carregando perfil...</p>
            </div>
          )}

          {error && !loading && (
            <div className="business-profile-error">
              ⚠️ {error}
            </div>
          )}

          {success && (
            <div className="business-profile-success">
              Perfil atualizado com sucesso!
            </div>
          )}

          {!loading && !error && (
            <>
              {/* About */}
              <div className="business-profile-field">
                <label>
                  Sobre
                  <span className="business-profile-help">(max 139 caracteres)</span>
                </label>
                <input
                  type="text"
                  placeholder="Descrição curta do seu negócio"
                  value={profile.about}
                  onChange={(e) => setProfile({ ...profile, about: e.target.value })}
                  maxLength={139}
                />
                <small>{profile.about.length}/139 caracteres</small>
              </div>

              {/* Description */}
              <div className="business-profile-field">
                <label>
                  Descrição
                  <span className="business-profile-help">(max 512 caracteres)</span>
                </label>
                <textarea
                  placeholder="Descrição detalhada do seu negócio"
                  value={profile.description}
                  onChange={(e) => setProfile({ ...profile, description: e.target.value })}
                  maxLength={512}
                  rows={4}
                />
                <small>{profile.description.length}/512 caracteres</small>
              </div>

              {/* Address */}
              <div className="business-profile-field">
                <label>
                  Endereço
                  <span className="business-profile-help">(max 256 caracteres)</span>
                </label>
                <input
                  type="text"
                  placeholder="Endereço completo do negócio"
                  value={profile.address}
                  onChange={(e) => setProfile({ ...profile, address: e.target.value })}
                  maxLength={256}
                />
                <small>{profile.address.length}/256 caracteres</small>
              </div>

              {/* Email */}
              <div className="business-profile-field">
                <label>Email</label>
                <input
                  type="email"
                  placeholder="contato@empresa.com"
                  value={profile.email}
                  onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                />
              </div>

              {/* Vertical (Categoria) */}
              <div className="business-profile-field">
                <label>Categoria do Negócio</label>
                <select
                  value={profile.vertical}
                  onChange={(e) => setProfile({ ...profile, vertical: e.target.value })}
                >
                  <option value="">Selecione uma categoria</option>
                  {verticals.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Websites */}
              <div className="business-profile-field">
                <label>
                  Websites
                  <span className="business-profile-help">(max 2)</span>
                </label>
                
                {profile.websites.map((website, index) => (
                  <div key={index} className="business-profile-website">
                    <input
                      type="url"
                      placeholder="https://exemplo.com"
                      value={website}
                      onChange={(e) => handleWebsiteChange(index, e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => removeWebsite(index)}
                      className="business-profile-remove-website"
                    >
                      ✕
                    </button>
                  </div>
                ))}

                {profile.websites.length < 2 && (
                  <button
                    type="button"
                    onClick={addWebsite}
                    className="business-profile-add-website"
                  >
                    + Adicionar Website
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="business-profile-footer">
          <button
            className="business-profile-btn-cancel"
            onClick={onClose}
            disabled={saving}
          >
            Cancelar
          </button>
          <button
            className="business-profile-btn-save"
            onClick={handleSave}
            disabled={saving || loading || !hasChanges}
          >
            {saving ? (
              <>
                <div className="business-profile-spinner-small" />
                Salvando...
              </>
            ) : (
              <>
                <MdSave />
                Salvar Alterações
              </>
            )}
          </button>
        </div>

        {/* Info */}
        <div className="business-profile-info">
          <strong>💡 Dica:</strong> Mantenha as informações atualizadas para que seus clientes possam encontrar e confiar no seu negócio.
        </div>
      </div>
    </div>
  );
};

export default BusinessProfile;
