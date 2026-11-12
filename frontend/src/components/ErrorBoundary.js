/**
 * ErrorBoundary — rede de segurança pra qualquer erro de render não tratado
 * em qualquer lugar da árvore. Sem isso, um bug em QUALQUER componente
 * (ex.: um provider de WhatsApp devolvendo um formato inesperado) derruba a
 * aplicação inteira pra tela preta, exigindo recarregar — React não
 * recupera sozinho de um erro de render sem um boundary explícito.
 */
import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Erro não tratado:', error, info?.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
          background: 'var(--bg-primary, #fff)', color: 'var(--text-primary, #333)', padding: 24, textAlign: 'center',
        }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Algo deu errado nesta tela.</div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary, #888)', maxWidth: 420 }}>
            Um componente encontrou um erro inesperado. Recarregue a página para continuar.
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: 'var(--whatsapp-green, #25D366)', color: '#fff', border: 'none',
              borderRadius: 8, padding: '10px 20px', fontWeight: 600, cursor: 'pointer',
            }}
          >
            Recarregar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
