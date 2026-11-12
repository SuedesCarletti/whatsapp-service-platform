import React, { useState } from 'react';
import { FiMail, FiLock } from 'react-icons/fi';
import apiService from '../services/api';
import '../styles/LoginScreen.css';

const LoginScreen = ({ onLogin }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    if (!email || !password) {
      setError("Preencha todos os campos.");
      setLoading(false);
      return;
    }

    try {
      const userData = await apiService.login(email, password);
      const displayName = userData.user?.full_name || userData.user?.email || email;
      onLogin(userData.token, displayName, userData.user);
    } catch (err) {
      setError(err.message || 'Erro de conexão ou credenciais inválidas.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-brand-panel">
          <img src="/assets/app-logo-white.png" alt="WPP Lab" className="login-brand-logo" />
          <div className="login-brand-headline">Central de Comunicação</div>
          <div className="login-brand-footer">WPP Lab — ambiente de teste</div>
        </div>

        <div className="login-form-panel">
          <div className="login-form-inner">
            <div className="login-title">Bem-vindo de volta</div>
            <p className="login-subtitle">Entre com sua conta.</p>

            <form onSubmit={handleSubmit} className="login-form">
              <div className="input-group">
                <FiMail className="input-icon" />
                <input
                  type="email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  disabled={loading}
                  required
                />
              </div>

              <div className="input-group">
                <FiLock className="input-icon" />
                <input
                  type="password"
                  placeholder="Senha"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={loading}
                  required
                />
              </div>

              <div className="login-forgot-row">
                <a href="#forgot">Esqueceu a senha?</a>
              </div>

              {error && <div className="login-error">⚠️ {error}</div>}

              <button type="submit" disabled={loading} className="login-button">
                {loading ? <div className="login-spinner" /> : 'Entrar'}
              </button>
            </form>

            <div className="login-footer">
              <p>Precisa de acesso? Fale com o administrador da sua conta.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginScreen;
