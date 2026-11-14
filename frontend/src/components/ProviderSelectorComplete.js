// frontend/src/components/ProviderSelectorComplete.js
//
// ALTERAÇÕES EM RELAÇÃO À VERSÃO ANTERIOR:
//   + prop `onProviderSelected(providerType)` → chamada ao clicar "Configurar"
//   + prop `onCancel`                         → botão voltar/cancelar
//
import React, { useState } from 'react';
import '../styles/ProviderSelector.css';

// PATCH: agora recebe as duas props necessárias
const ProviderSelectorComplete = ({ onProviderSelected, onCancel }) => {
  const [userNeeds, setUserNeeds] = useState({
    budget: null,        // low, medium, high
    teamSize: null,      // 1-5, 6-20, 21+
    useCase: null,       // support, marketing, sales, all
    riskTolerance: null, // none, low, medium, high
    needsApp: null,      // true/false
    volume: null,        // <1k, 1k-10k, 10k-100k, 100k+
  });

  const [recommendedProvider, setRecommendedProvider] = useState(null);

  const providers = {
    meta_cloud_basic: {
      name: 'Meta Cloud API',
      tier: 'Starter',
      price: 'R$ 0-299',
      risk: 'Zero',
      needsApp: false,
      forMarketing: false,
      setup: 'Médio',
    },
    meta_cloud_coexistence: {
      name: 'Meta Coexistence',
      tier: 'Business',
      price: 'R$ 299-499',
      risk: 'Zero',
      needsApp: true,
      forMarketing: false,
      setup: 'Médio',
    },
    meta_cloud_mmlite: {
      name: 'Meta MM Lite',
      tier: 'Professional',
      price: 'R$ 399-599',
      risk: 'Zero',
      needsApp: false,
      forMarketing: true,
      setup: 'Avançado',
    },
    meta_cloud_full: {
      name: 'Meta Full Stack',
      tier: 'Enterprise',
      price: 'R$ 599+',
      risk: 'Zero',
      needsApp: true,
      forMarketing: true,
      setup: 'Avançado',
    },
    baileys: {
      name: 'Baileys',
      tier: 'Free',
      price: 'Grátis',
      risk: 'Alto',
      needsApp: false,
      forMarketing: false,
      setup: 'Fácil',
    },
  };

  const getRecommendation = () => {
    const { budget, useCase, riskTolerance, needsApp, volume } = userNeeds;

    if (riskTolerance === 'high' && budget === 'low') return 'baileys';
    if (needsApp && useCase === 'marketing')           return 'meta_cloud_full';
    if (needsApp && budget === 'medium')               return 'meta_cloud_coexistence';
    if (useCase === 'marketing' && volume === '10k-100k') return 'meta_cloud_mmlite';
    return 'meta_cloud_basic';
  };

  const handleRecommend = () => {
    setRecommendedProvider(getRecommendation());
  };

  return (
    <div className="provider-wizard">
      <h1>🎯 Encontre o Melhor Modo para Você</h1>

      {/* Quiz de Necessidades */}
      <div className="needs-quiz">

        {/* Orçamento */}
        <div className="quiz-question">
          <h3>💰 Qual seu orçamento mensal?</h3>
          <div className="options">
            <button
              className={userNeeds.budget === 'low' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, budget: 'low' })}
            >
              Grátis ou muito baixo
            </button>
            <button
              className={userNeeds.budget === 'medium' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, budget: 'medium' })}
            >
              R$ 200-500/mês
            </button>
            <button
              className={userNeeds.budget === 'high' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, budget: 'high' })}
            >
              R$ 500+/mês
            </button>
          </div>
        </div>

        {/* Uso do App */}
        <div className="quiz-question">
          <h3>📱 Você quer usar WhatsApp Business App no celular?</h3>
          <div className="options">
            <button
              className={userNeeds.needsApp === true ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, needsApp: true })}
            >
              Sim, quero app + painel web
            </button>
            <button
              className={userNeeds.needsApp === false ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, needsApp: false })}
            >
              ❌ Não, só painel web
            </button>
          </div>
        </div>

        {/* Caso de Uso */}
        <div className="quiz-question">
          <h3>🎯 Qual seu principal objetivo?</h3>
          <div className="options">
            <button
              className={userNeeds.useCase === 'support' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, useCase: 'support' })}
            >
              Atendimento/Suporte
            </button>
            <button
              className={userNeeds.useCase === 'marketing' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, useCase: 'marketing' })}
            >
              Marketing e Campanhas
            </button>
            <button
              className={userNeeds.useCase === 'sales' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, useCase: 'sales' })}
            >
              Vendas
            </button>
            <button
              className={userNeeds.useCase === 'all' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, useCase: 'all' })}
            >
              Todos acima
            </button>
          </div>
        </div>

        {/* Volume */}
        <div className="quiz-question">
          <h3>📊 Quantas mensagens por mês?</h3>
          <div className="options">
            <button
              className={userNeeds.volume === '<1k' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, volume: '<1k' })}
            >
              Menos de 1.000
            </button>
            <button
              className={userNeeds.volume === '1k-10k' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, volume: '1k-10k' })}
            >
              1.000 – 10.000
            </button>
            <button
              className={userNeeds.volume === '10k-100k' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, volume: '10k-100k' })}
            >
              10.000 – 100.000
            </button>
            <button
              className={userNeeds.volume === '100k+' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, volume: '100k+' })}
            >
              Mais de 100.000
            </button>
          </div>
        </div>

        {/* Tolerância a Risco */}
        <div className="quiz-question">
          <h3>⚖️ Qual sua tolerância a risco de bloqueio?</h3>
          <div className="options">
            <button
              className={userNeeds.riskTolerance === 'none' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, riskTolerance: 'none' })}
            >
              Zero — Só API oficial
            </button>
            <button
              className={userNeeds.riskTolerance === 'high' ? 'selected' : ''}
              onClick={() => setUserNeeds({ ...userNeeds, riskTolerance: 'high' })}
            >
              Alta — Aceito risco para economizar
            </button>
          </div>
        </div>

        <div className="quiz-actions">
          <button className="btn-recommend" onClick={handleRecommend}>
            Ver Recomendação →
          </button>

          {/* PATCH: botão cancelar */}
          {onCancel && (
            <button className="btn-cancel-quiz" onClick={onCancel}>
              ← Voltar
            </button>
          )}
        </div>
      </div>

      {/* Resultado */}
      {recommendedProvider && providers[recommendedProvider] && (
        <div className="recommendation-result">
          <h2>✨ Recomendamos: {providers[recommendedProvider].name}</h2>
          <div className="provider-details">
            <p><strong>Tier:</strong> {providers[recommendedProvider].tier}</p>
            <p><strong>Preço:</strong> {providers[recommendedProvider].price}</p>
            <p><strong>Risco:</strong> {providers[recommendedProvider].risk}</p>

            {providers[recommendedProvider].needsApp && (
              <div className="highlight">Permite usar app no celular!</div>
            )}
            {providers[recommendedProvider].forMarketing && (
              <div className="highlight">📣 Otimizado para marketing!</div>
            )}
          </div>

          <div className="result-actions">
            {/* PATCH: onClick conectado via prop */}
            <button
              className="btn-select"
              onClick={() => onProviderSelected && onProviderSelected(recommendedProvider)}
            >
              Configurar {providers[recommendedProvider].name}
            </button>

            <button
              className="btn-restart"
              onClick={() => setRecommendedProvider(null)}
            >
              Refazer Quiz
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProviderSelectorComplete;
