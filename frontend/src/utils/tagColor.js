/**
 * Decide se o texto de uma etiqueta deve ser preto ou branco a partir da cor
 * de fundo escolhida (hex), via luminância relativa (fórmula YIQ). Antes a
 * cor do texto era sempre branca fixa, o que ficava ilegível em fundos claros
 * (ex: amarelo da paleta de criação rápida em ChatArea.js).
 */
export function getContrastTextColor(hexColor) {
  if (!hexColor) return '#fff';
  const hex = hexColor.replace('#', '');
  if (hex.length !== 3 && hex.length !== 6) return '#fff';
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return '#fff';
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? '#1a1a1a' : '#fff';
}
