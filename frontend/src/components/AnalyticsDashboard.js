/**
 * AnalyticsDashboard Component - Visualização de métricas do WhatsApp Business
 * 
 * Exibe estatísticas detalhadas de mensagens, conversas e custos
 */
import React, { useState, useEffect } from 'react';
import { MdClose, MdRefresh, MdTrendingUp, MdTrendingDown } from 'react-icons/md';
import { BsGraphUp, BsChat, BsCurrencyDollar } from 'react-icons/bs';
import { api } from '../services/api';
import '../styles/AnalyticsDashboard.css';

const AnalyticsDashboard = ({ onClose }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  
  // Filtros
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 7); // Últimos 7 dias
    return date.toISOString().split('T')[0];
  });
  
  const [endDate, setEndDate] = useState(() => {
    return new Date().toISOString().split('T')[0];
  });
  
  const [granularity, setGranularity] = useState('DAILY');

  // Carregar analytics ao montar
  useEffect(() => {
    loadAnalytics();
  }, []);

  const loadAnalytics = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await api.post('/api/extended/analytics', {
        start: startDate,
        end: endDate,
        granularity: granularity
      });

      console.log('Analytics recebido:', response.data);
      setAnalytics(response.data.data);

    } catch (err) {
      console.error('Erro ao carregar analytics:', err);
      setError(err.response?.data?.detail || 'Erro ao carregar analytics');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = () => {
    loadAnalytics();
  };

  // Formatar números
  const formatNumber = (num) => {
    if (num === undefined || num === null) return '0';
    return num.toLocaleString('pt-BR');
  };

  // Formatar moeda
  const formatCurrency = (value) => {
    if (value === undefined || value === null) return 'R$ 0,00';
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  };

  // Calcular taxa
  const calculateRate = (value, total) => {
    if (!total || total === 0) return 0;
    return ((value / total) * 100).toFixed(1);
  };

  // Renderizar métrica
  const renderMetric = (title, value, icon, color, subtitle) => (
    <div className="analytics-card">
      <div className="analytics-card-header">
        <div className={`analytics-card-icon ${color}`}>
          {icon}
        </div>
        <div className="analytics-card-title">{title}</div>
      </div>
      <div className="analytics-card-value">{value}</div>
      {subtitle && (
        <div className="analytics-card-subtitle">{subtitle}</div>
      )}
    </div>
  );

  return (
    <div className="analytics-overlay" onClick={onClose}>
      <div className="analytics-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="analytics-header">
          <div className="analytics-title">
            <BsGraphUp size={24} />
            <h2>Analytics Dashboard</h2>
          </div>
          <div className="analytics-actions">
            <button
              className="analytics-btn-refresh"
              onClick={handleRefresh}
              disabled={loading}
              title="Atualizar"
            >
              <MdRefresh size={20} />
            </button>
            <button className="analytics-close" onClick={onClose}>
              <MdClose size={24} />
            </button>
          </div>
        </div>

        {/* Filtros */}
        <div className="analytics-filters">
          <div className="analytics-filter-group">
            <label>Data Início</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              max={endDate}
            />
          </div>

          <div className="analytics-filter-group">
            <label>Data Fim</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate}
              max={new Date().toISOString().split('T')[0]}
            />
          </div>

          <div className="analytics-filter-group">
            <label>Granularidade</label>
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value)}
            >
              <option value="HALF_HOUR">30 minutos</option>
              <option value="DAILY">Diário</option>
              <option value="MONTHLY">Mensal</option>
            </select>
          </div>

          <button
            className="analytics-btn-apply"
            onClick={loadAnalytics}
            disabled={loading}
          >
            Aplicar
          </button>
        </div>

        {/* Body */}
        <div className="analytics-body">
          {loading && (
            <div className="analytics-loading">
              <div className="analytics-spinner" />
              <p>Carregando analytics...</p>
            </div>
          )}

          {error && (
            <div className="analytics-error">
              ⚠️ {error}
              <button onClick={loadAnalytics}>Tentar Novamente</button>
            </div>
          )}

          {!loading && !error && analytics && (
            <>
              {/* Métricas Principais - Mensagens */}
              <div className="analytics-section">
                <h3 className="analytics-section-title">
                  📨 Mensagens
                </h3>
                <div className="analytics-grid">
                  {renderMetric(
                    'Enviadas',
                    formatNumber(analytics.messages?.sent || 0),
                    <BsChat size={24} />,
                    'blue',
                    null
                  )}
                  {renderMetric(
                    'Entregues',
                    formatNumber(analytics.messages?.delivered || 0),
                    <BsChat size={24} />,
                    'green',
                    `${calculateRate(analytics.messages?.delivered, analytics.messages?.sent)}% de taxa`
                  )}
                  {renderMetric(
                    'Lidas',
                    formatNumber(analytics.messages?.read || 0),
                    <BsChat size={24} />,
                    'purple',
                    `${calculateRate(analytics.messages?.read, analytics.messages?.delivered)}% de taxa`
                  )}
                  {renderMetric(
                    'Falhas',
                    formatNumber(analytics.messages?.failed || 0),
                    <BsChat size={24} />,
                    'red',
                    `${calculateRate(analytics.messages?.failed, analytics.messages?.sent)}% de taxa`
                  )}
                </div>
              </div>

              {/* Conversas */}
              <div className="analytics-section">
                <h3 className="analytics-section-title">
                  💬 Conversas
                </h3>
                <div className="analytics-grid">
                  {renderMetric(
                    'Total',
                    formatNumber(analytics.conversations?.total || 0),
                    <BsChat size={24} />,
                    'blue',
                    null
                  )}
                  {renderMetric(
                    'Iniciadas pelo Negócio',
                    formatNumber(analytics.conversations?.business_initiated || 0),
                    <MdTrendingUp size={24} />,
                    'green',
                    `${calculateRate(analytics.conversations?.business_initiated, analytics.conversations?.total)}%`
                  )}
                  {renderMetric(
                    'Iniciadas pelo Usuário',
                    formatNumber(analytics.conversations?.user_initiated || 0),
                    <MdTrendingDown size={24} />,
                    'orange',
                    `${calculateRate(analytics.conversations?.user_initiated, analytics.conversations?.total)}%`
                  )}
                </div>
              </div>

              {/* Conversas por Categoria */}
              {analytics.conversations_by_category && (
                <div className="analytics-section">
                  <h3 className="analytics-section-title">
                    🏷️ Por Categoria
                  </h3>
                  <div className="analytics-grid">
                    {renderMetric(
                      'Marketing',
                      formatNumber(analytics.conversations_by_category.MARKETING || 0),
                      <BsChat size={24} />,
                      'purple',
                      null
                    )}
                    {renderMetric(
                      'Utilidade',
                      formatNumber(analytics.conversations_by_category.UTILITY || 0),
                      <BsChat size={24} />,
                      'blue',
                      null
                    )}
                    {renderMetric(
                      'Autenticação',
                      formatNumber(analytics.conversations_by_category.AUTHENTICATION || 0),
                      <BsChat size={24} />,
                      'green',
                      null
                    )}
                    {renderMetric(
                      'Serviço',
                      formatNumber(analytics.conversations_by_category.SERVICE || 0),
                      <BsChat size={24} />,
                      'orange',
                      null
                    )}
                  </div>
                </div>
              )}

              {/* Custos */}
              {analytics.cost && (
                <div className="analytics-section">
                  <h3 className="analytics-section-title">
                    💰 Custos
                  </h3>
                  <div className="analytics-grid">
                    {renderMetric(
                      'Custo Total',
                      formatCurrency(analytics.cost.total || 0),
                      <BsCurrencyDollar size={24} />,
                      'red',
                      null
                    )}
                    {renderMetric(
                      'Custo por Conversa',
                      formatCurrency(analytics.cost.per_conversation || 0),
                      <BsCurrencyDollar size={24} />,
                      'orange',
                      'Média'
                    )}
                  </div>
                </div>
              )}

              {/* Período */}
              <div className="analytics-period">
                📅 Período: {new Date(startDate).toLocaleDateString('pt-BR')} até {new Date(endDate).toLocaleDateString('pt-BR')}
              </div>
            </>
          )}

          {/* Empty State */}
          {!loading && !error && !analytics && (
            <div className="analytics-empty">
              <BsGraphUp size={64} />
              <p>Nenhum dado disponível</p>
              <small>Configure os filtros e clique em "Aplicar"</small>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AnalyticsDashboard;
