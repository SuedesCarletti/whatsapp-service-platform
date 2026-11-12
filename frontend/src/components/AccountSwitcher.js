/**
 * AccountSwitcher — Seletor de conta WhatsApp no Sidebar
 *
 * [FIX 1] Token lido com chave 'token' (igual ao restante do app)
 * [FIX 2] onSelectAccount recebe guard para evitar crash quando undefined
 */
import React, { useEffect, useState, useRef } from 'react';
import { BsChevronDown, BsCircleFill } from 'react-icons/bs';
import '../styles/AccountSwitcher.css';
import apiService from '../services/api';

const PROVIDER_LABELS = {
  baileys:                'Baileys',
  venom:                  'Venom',
  whatsapp_web_js:        'WA-Web.js',
  wppconnect:             'WPPConnect',
  meta_cloud_basic:       'Cloud API',
  meta_cloud_coexistence: 'Coexistence',
  meta_cloud_mmlite:      'MM Lite',
  meta_cloud_full:        'Full Stack',
  site_chat:              '🌐 Site',
};

const isUnofficial = (provider) =>
  ['baileys', 'venom', 'whatsapp_web_js', 'wppconnect'].includes(provider);

export default function AccountSwitcher({ selectedAccountId, onSelectAccount }) {
  const [accounts, setAccounts] = useState([]);
  const [open, setOpen]         = useState(false);
  const ref = useRef(null);
  // Ref (não dep do efeito de poll) pra não reiniciar o interval a cada
  // troca de conta — só precisa do valor mais atual dentro do fetchAccounts.
  const selectedAccountIdRef = useRef(selectedAccountId);
  useEffect(() => { selectedAccountIdRef.current = selectedAccountId; }, [selectedAccountId]);

  // [FIX 1] Chave correta: 'token' — igual a handleLogin/handleLogout no App.js
  // Refaz a busca periodicamente: GET /accounts já checa o status ao vivo do bridge
  // e autocorrige o banco quando ele diverge, mas se essa tela só busca uma vez ao
  // montar, o indicador fica preso no status de quando a página carregou — podendo
  // mostrar "desconectado" mesmo depois da sessão ter reconectado (ex: durante um
  // restart do bridge), enquanto outras telas que rebuscam (ex: Configurações)
  // já mostram o status correto.
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;

    const fetchAccounts = () => {
      apiService.getAccounts()
        .then((rawList) => {
          // Contas Baileys criadas só como fallback de envio de outra conta
          // (ver fallback_for_account_id, backend/api/routes_settings.py) não
          // são contas WhatsApp de verdade pro usuário escolher aqui — nunca
          // têm conversas próprias (bloqueado no bridge), então aparecer no
          // trocador só confundiria (pareceria uma conta vazia/quebrada).
          const list = rawList.filter(a => !a.fallback_for_account_id);
          // apiService.getAccounts() engole qualquer erro de rede/timeout e
          // devolve [] em vez de rejeitar — sem essa guarda, uma falha
          // transitória (restart do backend, blip de rede) zerava a lista
          // local a cada poll (25s), e o switcher caía pra "Todas as contas"
          // até o próximo poll bem-sucedido — dando a impressão de que a
          // conta selecionada no topo trocava sozinha. Só aceita [] genuíno
          // quando ainda não tínhamos nada carregado.
          //
          // BUG (2026-09-08, ainda presente pra quem tem 2+ números): a
          // guarda acima só cobria a resposta TOTALMENTE vazia — uma
          // resposta não-vazia mas que, por qualquer instabilidade
          // transitória (timing entre polls, backend momentaneamente sem
          // aquela conta específica), vem SEM a conta atualmente selecionada
          // ainda derrubava a mesma UI: `selected = accounts.find(...)` dá
          // undefined e o botão do switcher pisca de volta pra "Todas as
          // contas" sozinho a cada ~25s, mesmo com selectedAccountId intacto
          // no App.js — visível principalmente em quem tem mais de um número
          // porque só ali o rótulo troca de verdade (com 1 conta só, "todas"
          // e "a conta" já mostram quase a mesma coisa). Generaliza a mesma
          // defesa: se a conta selecionada estava na lista anterior e sumiu
          // dessa resposta, mantém a lista anterior inteira.
          setAccounts((prev) => {
            if (list.length === 0 && prev.length > 0) return prev;
            const selectedId = selectedAccountIdRef.current;
            if (
              selectedId &&
              prev.some(a => a.id === selectedId) &&
              !list.some(a => a.id === selectedId)
            ) {
              return prev;
            }
            return list;
          });
        })
        .catch((err) => console.error('Failed to fetch accounts:', err));
    };

    fetchAccounts();
    const interval = setInterval(fetchAccounts, 25000);
    return () => clearInterval(interval);
  }, []);

  // Fecha dropdown ao clicar fora
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // [FIX 2] Guard: nunca chama onSelectAccount se não for função
  // Passa o array local de accounts como 2º argumento para App.js poder
  // setar selectedAccount sem precisar de uma nova chamada de API.
  const selectAccount = (id) => {
    if (typeof onSelectAccount === 'function') onSelectAccount(id, accounts);
    setOpen(false);
  };

  const selected = accounts.find((a) => a.id === selectedAccountId);

  const statusDot = (account) => {
    if (account.is_authenticated) return 'dot-online';
    if (account.authentication_status === 'QR_REQUIRED') return 'dot-pending';
    return 'dot-offline';
  };

  return (
    <div className="account-switcher" ref={ref}>
      <button
        className="account-switcher-btn"
        onClick={() => setOpen((v) => !v)}
        title="Trocar conta WhatsApp"
      >
        <span className="account-switcher-label">
          {selected ? (
            <>
              <BsCircleFill className={`account-dot ${statusDot(selected)}`} size={8} />
              <span className="account-switcher-name">{selected.account_name}</span>
              <span className="account-switcher-provider">
                {PROVIDER_LABELS[selected.provider_type] || selected.provider_type}
              </span>
            </>
          ) : (
            <span className="account-switcher-name">Todas as contas</span>
          )}
        </span>
        <BsChevronDown size={12} className={`account-switcher-arrow ${open ? 'open' : ''}`} />
      </button>

      {open && (
        <div className="account-switcher-dropdown">
          {/* Opção "todas" */}
          <div
            className={`account-option ${!selectedAccountId ? 'active' : ''}`}
            onClick={() => selectAccount(null)}
          >
            <span className="account-option-name">Todas as contas</span>
          </div>

          {accounts.length > 0 && <div className="account-divider" />}

          {accounts.map((acc) => (
            <div
              key={acc.id}
              className={`account-option ${selectedAccountId === acc.id ? 'active' : ''}`}
              onClick={() => selectAccount(acc.id)}
            >
              <BsCircleFill className={`account-dot ${statusDot(acc)}`} size={8} />
              <div className="account-option-info">
                <span className="account-option-name">{acc.account_name}</span>
                <span className="account-option-meta">
                  {acc.provider_type === 'site_chat' ? '' : `${acc.phone_number} · `}{PROVIDER_LABELS[acc.provider_type] || acc.provider_type}
                  {isUnofficial(acc.provider_type) && !acc.is_authenticated && (
                    <span className="account-option-badge">Não conectado</span>
                  )}
                </span>
              </div>
            </div>
          ))}

          {accounts.length === 0 && (
            <div className="account-option-empty">Nenhuma conta cadastrada</div>
          )}
        </div>
      )}
    </div>
  );
}
