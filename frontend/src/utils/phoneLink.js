/**
 * Detecta números de telefone em texto de mensagem e transforma em algo
 * clicável — igual ao WhatsApp de verdade, que reconhece um número escrito
 * na conversa e deixa abrir o chat com ele. Usado tanto em ChatArea.js
 * (clientes) quanto em InternalChatArea.js (equipe, pra alguém colar o
 * número de um cliente numa conversa interna e já abrir o chat dele).
 *
 * O regex evita casar dígitos vizinhos de "/", "." ou "@" justamente pra não
 * pegar parte de uma URL (ex: ".../pedido/12345678") ou e-mail.
 */
import React from 'react';

const PHONE_REGEX = /(?<![\d/.@])(\+?\d[\d\s\-().]{6,}\d)(?![\d/@])/g;

const isPlausiblePhone = (digits) => digits.length >= 8 && digits.length <= 15;

export function linkifyPhoneNumbers(text) {
  if (!text) return text;
  return text.replace(PHONE_REGEX, (match) => {
    const digits = match.replace(/\D/g, '');
    // Faixa de um número de telefone de verdade (com DDI+DDD) — fora disso
    // é mais provável ser preço, CEP, número de pedido etc.
    if (!isPlausiblePhone(digits)) return match;
    return `<span class="wa-phone-link" data-phone="${digits}" title="Clique para conversar com este número">${match}</span>`;
  });
}

/**
 * Mesma detecção, mas devolvendo nós React em vez de string HTML — pra uso
 * em componentes que renderizam texto puro (sem dangerouslySetInnerHTML,
 * caso de InternalChatArea.js). onPhoneClick recebe os dígitos já limpos.
 */
export function renderTextWithPhoneLinks(text, onPhoneClick) {
  if (!text) return text;
  const regex = new RegExp(PHONE_REGEX);
  const nodes = [];
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    const digits = match[0].replace(/\D/g, '');
    if (!isPlausiblePhone(digits)) continue;
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    nodes.push(
      <span
        key={`phone-${key++}`}
        className="wa-phone-link"
        title="Clique para conversar com este número"
        onClick={(e) => { e.stopPropagation(); onPhoneClick(digits); }}
      >
        {match[0]}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }
  if (nodes.length === 0) return text;
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/**
 * DDD+número sem o 55 na frente (10 ou 11 dígitos, o caso mais comum de
 * alguém colar um número brasileiro sem DDI) ganha o 55 automaticamente —
 * mesma heurística já usada em NewChatModal.js ("Adicionar 55
 * automaticamente"). Já vindo com DDI (12-13 dígitos) ou "+", mantém como
 * está.
 */
export function normalizePhoneDigits(digits) {
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

export function extractPhoneFromClick(target) {
  const el = target?.closest?.('.wa-phone-link');
  if (!el) return null;
  return el.dataset.phone || null;
}
