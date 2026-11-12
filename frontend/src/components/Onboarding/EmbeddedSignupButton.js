/**
 * EmbeddedSignupButton.js
 *
 * Fluxo de conexão automática do WhatsApp Business via Embedded Signup da
 * Meta, pensado pra quem nunca mexeu com API — o popup da própria Meta
 * cuida de escolher/criar a conta do WhatsApp Business e verificar o
 * número por SMS; aqui só cuidamos de deixar cada etapa clara (sem termos
 * técnicos tipo "token"/"code") e de guiar o único passo manual que sobra
 * (o PIN de segurança do número).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FaFacebook } from 'react-icons/fa';
import { MdCheckCircle, MdError, MdInfoOutline, MdAutorenew, MdContentCopy } from 'react-icons/md';
import apiService from '../../services/api';

const SDK_SRC = 'https://connect.facebook.net/pt_BR/sdk.js';

function loadFacebookSdk(appId) {
  return new Promise((resolve, reject) => {
    if (window.FB) {
      resolve(window.FB);
      return;
    }
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: 'v23.0' });
      resolve(window.FB);
    };
    if (document.getElementById('facebook-jssdk')) return;
    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error('Falha ao carregar o SDK do Facebook'));
    document.body.appendChild(script);
  });
}

function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Traduz os erros mais comuns pra linguagem simples; qualquer coisa fora
// dessa lista continua acessível em "ver detalhes técnicos", sem sumir.
function friendlyError(raw) {
  const text = (raw || '').toLowerCase();
  if (text.includes('cancel')) return 'Você fechou a janela antes de terminar. Pode tentar de novo quando quiser.';
  if (text.includes('permission') || text.includes('permissão')) return 'Não recebemos as permissões necessárias no Facebook. Tente novamente e aceite tudo que for pedido.';
  if (text.includes('token') || text.includes('oauth') || text.includes('code')) return 'A conexão com o Facebook expirou ou falhou. Tente novamente.';
  if (text.includes('pin')) return 'O PIN não foi aceito pela Meta. Tente um PIN diferente (6 números).';
  return 'Algo deu errado na conexão. Você pode tentar de novo — se continuar falhando, chame um administrador.';
}

const STATUS_LABEL = {
  'loading-sdk': 'Carregando...',
  waiting: 'Continue na janela que abriu...',
  exchanging: 'Conectando sua conta...',
  creating: 'Conectando sua conta...',
};

const EmbeddedSignupButton = ({ onConnected, onCancel, providerType }) => {
  // "full" inclui Coexistência (é Coexistência + MM Lite juntos), então também
  // usa a configuração de signup de Coexistência — mas o backend só bloqueia o
  // passo de PIN pra "coexistence" puro (register-number trata "full" como
  // básico por ora, ambíguo até confirmação ao vivo), então são duas flags.
  const wantsCoexistenceConfig = providerType === 'meta_cloud_coexistence' || providerType === 'meta_cloud_full';
  const skipPinStep = providerType === 'meta_cloud_coexistence';
  const [config, setConfig] = useState(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [status, setStatus] = useState('idle'); // idle | loading-sdk | waiting | exchanging | creating | pin | registering | done | error
  const [errorMsg, setErrorMsg] = useState('');
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  const [pin, setPin] = useState('');
  const [createdAccountId, setCreatedAccountId] = useState(null);
  const [createdAccountInfo, setCreatedAccountInfo] = useState(null); // { account_name, phone_number }
  const [pinCopied, setPinCopied] = useState(false);

  const sessionInfoRef = useRef(null); // { waba_id, phone_number_id, business_id }
  const authCodeRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await apiService.getEmbeddedSignupConfig();
        setConfig(cfg);
        if (cfg.configured) {
          setStatus('loading-sdk');
          await loadFacebookSdk(cfg.fb_app_id);
          setSdkReady(true);
          setStatus('idle');
        }
      } catch (e) {
        setErrorMsg('Não foi possível carregar a configuração. Tente recarregar a página.');
        setStatus('error');
      }
    })();
  }, []);

  const showError = (raw) => {
    setErrorMsg(raw || '');
    setShowErrorDetail(false);
    setStatus('error');
  };

  const tryFinish = useCallback(async () => {
    if (!authCodeRef.current || !sessionInfoRef.current) return;
    if (!sessionInfoRef.current.waba_id || !sessionInfoRef.current.phone_number_id) return;

    setStatus('exchanging');
    setErrorMsg('');
    try {
      const exchange = await apiService.exchangeEmbeddedSignupCode(authCodeRef.current);
      if (!exchange.success || !exchange.access_token) {
        throw new Error('Troca de token falhou');
      }

      setStatus('creating');
      const created = await apiService.createAccountFromSignup({
        waba_id: sessionInfoRef.current.waba_id,
        phone_number_id: sessionInfoRef.current.phone_number_id,
        business_id: sessionInfoRef.current.business_id || null,
        access_token: exchange.access_token,
        provider_type: providerType || 'meta_cloud_basic',
      });

      setCreatedAccountId(created.data.id);
      setCreatedAccountInfo(created.data);

      if (skipPinStep) {
        // Coexistência: o número continua ativo no app do celular, não passa
        // pelo passo de PIN/registro (que "entrega" o número só pra Cloud API).
        setStatus('done');
        setTimeout(() => { onConnected && onConnected(created.data.id); }, 1800);
      } else {
        setPin(generatePin());
        setStatus('pin');
      }
    } catch (e) {
      showError(e?.response?.data?.detail || e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerType, skipPinStep]);

  useEffect(() => {
    const handler = (event) => {
      if (!event.origin.endsWith('facebook.com')) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type !== 'WA_EMBEDDED_SIGNUP') return;

      if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA') {
        sessionInfoRef.current = {
          waba_id: data.data?.waba_id,
          phone_number_id: data.data?.phone_number_id,
          business_id: data.data?.business_id,
        };
        tryFinish();
      } else if (data.event === 'CANCEL') {
        showError('cancelled');
      } else if (data.event === 'ERROR') {
        showError(data.data?.error_message || 'embedded signup error');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tryFinish]);

  const handleLogin = () => {
    if (!window.FB || !config) return;

    // Confirmado no App Dashboard da Meta (Início do Cadastro Incorporado):
    // Coexistência NÃO precisa de uma configuração de login separada — é a
    // MESMA config_id, só muda o `featureType` nos extras do FB.login(). O
    // campo de config_id de Coexistência em Configurações fica como override
    // opcional (só usado se alguém realmente configurar um valor diferente lá).
    const configId = (wantsCoexistenceConfig && config.coexistence_embedded_signup_config_id)
      || config.embedded_signup_config_id;

    setStatus('waiting');
    setErrorMsg('');
    window.FB.login(
      (response) => {
        if (response.authResponse && response.authResponse.code) {
          authCodeRef.current = response.authResponse.code;
          tryFinish();
        } else {
          showError('permission denied');
        }
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          sessionInfoVersion: '3',
          version: 'v4',
          // featureType confirmado ao vivo no App Dashboard da Meta pra
          // Coexistência. `features: [{name: "app_only_install"}]` aparece
          // como opcional lá (parece ser uma variante "só o app, sem Cloud
          // API" — o oposto do que queremos) — deixado de fora por padrão.
          ...(wantsCoexistenceConfig ? { featureType: 'whatsapp_business_app_onboarding' } : {}),
        },
      }
    );
  };

  const handleRegisterPin = async () => {
    if (!/^\d{6}$/.test(pin)) {
      setErrorMsg('O código precisa ter exatamente 6 números.');
      return;
    }
    setStatus('registering');
    setErrorMsg('');
    try {
      await apiService.registerSignupNumber(createdAccountId, pin);
      setStatus('done');
      // Espera dar tempo da mensagem de sucesso aparecer antes do componente
      // pai fechar essa tela (senão o "Tudo pronto!" nunca chega a ser visto).
      setTimeout(() => { onConnected && onConnected(createdAccountId); }, 1800);
    } catch (e) {
      setErrorMsg(e?.response?.data?.detail ? friendlyError(e.response.data.detail) : 'Não deu pra ativar o número agora — sua conta já foi criada, você pode tentar de novo em Contas WA.');
      setStatus('pin');
    }
  };

  const copyPin = () => {
    navigator.clipboard?.writeText(pin);
    setPinCopied(true);
    setTimeout(() => setPinCopied(false), 1500);
  };

  if (config && !config.configured) {
    return (
      <div className="es-box es-box-warn">
        <MdInfoOutline size={16} /> Conexão automática ainda não está disponível. Peça pra um administrador
        configurar em <strong>Configurações → App Meta</strong>.
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="es-box es-box-ok">
        <MdCheckCircle size={20} />
        <div>
          <strong>Tudo pronto!</strong>
          <div>
            {createdAccountInfo?.account_name || 'Sua conta'}
            {createdAccountInfo?.phone_number ? ` — ${createdAccountInfo.phone_number}` : ''} já está conectada e pronta pra usar.
          </div>
        </div>
      </div>
    );
  }

  if (status === 'pin' || status === 'registering') {
    return (
      <div className="es-pin-step">
        <div className="es-pin-title"><MdCheckCircle size={18} color="#2FAE60" /> Conta conectada!</div>
        <p>
          Só falta um passo: crie um código de segurança de 6 números pro seu número do WhatsApp — funciona
          como a senha de um cartão, é pra proteger seu WhatsApp Business e você vai precisar dele se
          precisar reativar o número um dia. <strong>Anote em um lugar seguro.</strong>
        </p>
        <div className="es-pin-row">
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            className="es-pin-input"
            disabled={status === 'registering'}
          />
          <button type="button" className="es-icon-btn" title="Gerar outro código" onClick={() => setPin(generatePin())} disabled={status === 'registering'}>
            <MdAutorenew size={18} />
          </button>
          <button type="button" className="es-icon-btn" title="Copiar código" onClick={copyPin} disabled={status === 'registering'}>
            <MdContentCopy size={16} />
          </button>
        </div>
        {pinCopied && <span className="es-pin-copied">Copiado!</span>}
        <button className="es-btn" onClick={handleRegisterPin} disabled={status === 'registering'}>
          {status === 'registering' ? 'Ativando...' : 'Confirmar e ativar meu número'}
        </button>
        {errorMsg && <div className="es-box es-box-error"><MdError size={14} /> {errorMsg}</div>}
      </div>
    );
  }

  const busy = ['waiting', 'exchanging', 'creating'].includes(status);

  return (
    <div className="es-container">
      {!busy && status !== 'error' && (
        <p className="es-intro">
          Clique abaixo, faça login no Facebook e escolha (ou crie) sua conta do WhatsApp Business.
          A própria Meta vai te guiar — inclusive confirmar seu número por SMS. Leva menos de 2 minutos.
        </p>
      )}
      <button
        className="es-fb-btn"
        onClick={handleLogin}
        disabled={!sdkReady || busy}
      >
        <FaFacebook size={18} />
        {busy ? STATUS_LABEL[status] : status === 'loading-sdk' ? STATUS_LABEL[status] : 'Conectar meu WhatsApp Business'}
      </button>
      {status === 'idle' && sdkReady && (
        <span className="es-sub">via login seguro do Facebook</span>
      )}
      {errorMsg && (
        <div className="es-box es-box-error">
          <MdError size={16} />
          <div>
            <div>{friendlyError(errorMsg)}</div>
            {errorMsg && errorMsg !== 'cancelled' && errorMsg !== 'permission denied' && (
              <button type="button" className="es-detail-toggle" onClick={() => setShowErrorDetail(v => !v)}>
                {showErrorDetail ? 'ocultar detalhes técnicos' : 'ver detalhes técnicos'}
              </button>
            )}
            {showErrorDetail && <div className="es-detail-text">{errorMsg}</div>}
          </div>
        </div>
      )}
      {onCancel && (
        <button className="es-link-btn" onClick={onCancel}>Prefiro preencher manualmente</button>
      )}
    </div>
  );
};

export default EmbeddedSignupButton;
