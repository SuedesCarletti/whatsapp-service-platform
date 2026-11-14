/**
 * LocationSender Component
 * 
 * Enviar coordenadas GPS
 * Buscar endereço por texto
 * Usar localização atual
 * Preview no mapa
 * Nome e endereço opcionais
 */
import React, { useState, useEffect } from 'react';
import { MdClose, MdSend, MdMyLocation, MdLocationOn, MdSearch } from 'react-icons/md';
import { BsGeoAltFill } from 'react-icons/bs';
import { api } from '../services/api';
import { getRecipientJid } from '../utils/recipient';
import '../styles/LocationSender.css';

const LocationSender = ({ conversation, onClose, onSent }) => {
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [locationName, setLocationName] = useState('');
  const [address, setAddress] = useState('');
  const [searchAddress, setSearchAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [gettingLocation, setGettingLocation] = useState(false);

  // Validar coordenadas
  const isValidCoordinates = () => {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    return !isNaN(lat) && !isNaN(lng) && 
           lat >= -90 && lat <= 90 && 
           lng >= -180 && lng <= 180;
  };

  // Obter localização atual do usuário
  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      setError('Geolocalização não suportada pelo navegador');
      return;
    }

    setGettingLocation(true);
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(position.coords.latitude.toFixed(6));
        setLongitude(position.coords.longitude.toFixed(6));
        setLocationName('Minha Localização Atual');
        setGettingLocation(false);
        
        // Tentar obter endereço via geocoding reverso (opcional)
        reverseGeocode(position.coords.latitude, position.coords.longitude);
      },
      (err) => {
        setGettingLocation(false);
        let errorMsg = 'Erro ao obter localização';
        
        switch (err.code) {
          case err.PERMISSION_DENIED:
            errorMsg = 'Permissão negada para acessar localização';
            break;
          case err.POSITION_UNAVAILABLE:
            errorMsg = 'Localização indisponível';
            break;
          case err.TIMEOUT:
            errorMsg = 'Tempo esgotado ao obter localização';
            break;
          default:
            errorMsg = 'Erro desconhecido ao obter localização';
        }
        
        setError(errorMsg);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  };

  // Geocoding reverso simples (usando OpenStreetMap Nominatim - gratuito)
  const reverseGeocode = async (lat, lng) => {
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
        {
          headers: {
            'User-Agent': 'WhatsApp-Business-Integration'
          }
        }
      );
      
      if (response.ok) {
        const data = await response.json();
        if (data.display_name) {
          setAddress(data.display_name);
        }
      }
    } catch (err) {
      console.error('Erro ao obter endereço:', err);
      // Não mostrar erro para o usuário, endereço é opcional
    }
  };

  // Buscar coordenadas por endereço (geocoding)
  const handleSearchAddress = async () => {
    if (!searchAddress.trim()) {
      setError('Digite um endereço para buscar');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchAddress)}&limit=1`,
        {
          headers: {
            'User-Agent': 'WhatsApp-Business-Integration'
          }
        }
      );
      
      if (response.ok) {
        const data = await response.json();
        
        if (data && data.length > 0) {
          const location = data[0];
          setLatitude(parseFloat(location.lat).toFixed(6));
          setLongitude(parseFloat(location.lon).toFixed(6));
          setLocationName(location.display_name.split(',')[0]);
          setAddress(location.display_name);
        } else {
          setError('Endereço não encontrado. Tente ser mais específico.');
        }
      } else {
        throw new Error('Erro na API de geocoding');
      }
    } catch (err) {
      console.error('Erro ao buscar endereço:', err);
      setError('Erro ao buscar endereço. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  // Enviar localização
  const handleSend = async () => {
    if (!conversation) {
      setError('Nenhuma conversa selecionada');
      return;
    }

    if (!isValidCoordinates()) {
      setError('Coordenadas inválidas');
      return;
    }

    try {
      setSending(true);
      setError(null);

      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);

      // BUG (2026-09-14, confirmado ao vivo): usava fetch() puro sem header
      // de Authorization nenhum — o backend rejeitava com 403 "Not
      // authenticated" antes mesmo de chegar na rota. Mesma causa raiz do
      // ContactSender/ListSender/ProductSender — troca pro `api` compartilhado
      // (services/api.js), que anexa o Bearer token via interceptor.
      await api.post('/api/send/location', {
        to: getRecipientJid(conversation),
        latitude: lat,
        longitude: lng,
        name: locationName || undefined,
        address: address || undefined,
        account_id: conversation.account_id || null
      });

      console.log('Localização enviada');
      setSuccess(true);
      onSent?.();

      // Fechar após 2 segundos
      setTimeout(() => {
        onClose();
      }, 2000);

    } catch (err) {
      console.error('Erro ao enviar localização:', err);
      setError(err.response?.data?.detail || err.message || 'Erro ao enviar localização');
    } finally {
      setSending(false);
    }
  };

  // Gerar URL do Google Maps
  const getGoogleMapsUrl = () => {
    if (!isValidCoordinates()) return '#';
    return `https://www.google.com/maps?q=${latitude},${longitude}`;
  };

  // Gerar URL de preview do mapa estático
  const getMapPreviewUrl = () => {
    if (!isValidCoordinates()) return null;
    // Usando OpenStreetMap para preview estático
    return `https://www.openstreetmap.org/export/embed.html?bbox=${parseFloat(longitude)-0.01},${parseFloat(latitude)-0.01},${parseFloat(longitude)+0.01},${parseFloat(latitude)+0.01}&layer=mapnik&marker=${latitude},${longitude}`;
  };

  return (
    <div className="location-sender-overlay" onClick={onClose}>
      <div className="location-sender-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="location-sender-header">
          <div className="location-sender-title">
            <BsGeoAltFill size={24} />
            <h2>Enviar Localização</h2>
          </div>
          <button className="location-sender-close" onClick={onClose}>
            <MdClose size={24} />
          </button>
        </div>

        {/* Body */}
        <div className="location-sender-body">
          {/* Botão: Usar localização atual */}
          <button
            className="btn-current-location"
            onClick={handleGetCurrentLocation}
            disabled={gettingLocation}
          >
            {gettingLocation ? (
              <>
                <div className="spinner-small"></div>
                Obtendo localização...
              </>
            ) : (
              <>
                <MdMyLocation size={20} />
                Usar Minha Localização Atual
              </>
            )}
          </button>

          <div className="divider">
            <span>OU</span>
          </div>

          {/* Buscar por endereço */}
          <div className="location-sender-field">
            <label>
              <MdSearch size={18} />
              Buscar Endereço
            </label>
            <div className="search-address-container">
              <input
                type="text"
                placeholder="Ex: Avenida Paulista, 1000, São Paulo"
                value={searchAddress}
                onChange={(e) => setSearchAddress(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearchAddress()}
              />
              <button
                className="btn-search"
                onClick={handleSearchAddress}
                disabled={loading}
              >
                {loading ? <div className="spinner-small"></div> : <MdSearch />}
              </button>
            </div>
          </div>

          <div className="divider">
            <span>OU</span>
          </div>

          {/* Coordenadas manuais */}
          <div className="coordinates-grid">
            <div className="location-sender-field">
              <label>Latitude</label>
              <input
                type="number"
                step="0.000001"
                placeholder="-23.550520"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
              />
            </div>
            <div className="location-sender-field">
              <label>Longitude</label>
              <input
                type="number"
                step="0.000001"
                placeholder="-46.633308"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
              />
            </div>
          </div>

          {/* Campos opcionais */}
          <div className="location-sender-field">
            <label>
              <MdLocationOn size={18} />
              Nome do Local (opcional)
            </label>
            <input
              type="text"
              placeholder="Ex: Escritório, Casa, Loja"
              value={locationName}
              onChange={(e) => setLocationName(e.target.value)}
            />
          </div>

          <div className="location-sender-field">
            <label>Endereço Completo (opcional)</label>
            <textarea
              placeholder="Ex: Av. Paulista, 1000 - Bela Vista, São Paulo - SP"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              rows={2}
            />
          </div>

          {/* Preview do mapa */}
          {isValidCoordinates() && (
            <div className="map-preview">
              <div className="preview-label">📍 Preview</div>
              <iframe
                src={getMapPreviewUrl()}
                width="100%"
                height="200"
                frameBorder="0"
                scrolling="no"
                title="Mapa de localização"
              ></iframe>
              <a
                href={getGoogleMapsUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="view-on-maps"
              >
                Ver no Google Maps →
              </a>
            </div>
          )}

          {/* Mensagens */}
          {error && (
            <div className="location-sender-error">
              ⚠️ {error}
            </div>
          )}

          {success && (
            <div className="location-sender-success">
              Localização enviada com sucesso!
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="location-sender-footer">
          <button className="btn-cancel" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn-send-location"
            onClick={handleSend}
            disabled={!isValidCoordinates() || sending}
          >
            {sending ? (
              <>
                <div className="spinner"></div>
                Enviando...
              </>
            ) : (
              <>
                <MdSend />
                Enviar Localização
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LocationSender;
