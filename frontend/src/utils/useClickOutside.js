import { useEffect } from 'react';

/**
 * Fecha um popover/dropdown ao clicar fora dele — padrão que já existia em
 * ChatAreaMenu.js (menu de 3 pontos), mas nunca foi aplicado nos outros
 * popovers do app (emoji/sticker/GIF do composer, reação de mensagem,
 * sugestões de resposta rápida...): sem isso, só fechavam clicando de novo
 * no botão que abriu, nunca clicando fora — obrigando um clique extra toda
 * vez. `active` evita registrar o listener quando o popover já está fechado.
 */
export default function useClickOutside(ref, onOutside, active = true) {
  useEffect(() => {
    if (!active) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [active, onOutside]); // eslint-disable-line react-hooks/exhaustive-deps
}
