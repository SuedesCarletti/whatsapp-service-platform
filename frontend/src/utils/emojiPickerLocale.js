/**
 * emojiPickerLocale — traduz os textos fixos do emoji-picker-react (nomes
 * de categoria, placeholder de busca), que vêm todos em inglês por padrão —
 * a lib não tem um prop de idioma pronto, só permite sobrescrever cada
 * categoria individualmente via a prop `categories`. Usado tanto no chat de
 * clientes (ChatArea.js) quanto no chat de equipe (InternalChatArea.js).
 */
import { Categories } from 'emoji-picker-react';
// Dataset de emoji com nomes/palavras-chave em português (a lib só busca
// pelo dataset carregado — sem isso, digitar "palhaço" não achava nada,
// só "clown" em inglês). Categorias aqui vêm com nomes meio estranhos
// ("comutadores" pra bandeiras) — por isso EMOJI_CATEGORIES_PT abaixo
// continua sobrescrevendo os rótulos, só o dataset de busca/nomes é
// deste arquivo.
export { default as EMOJI_DATA_PT } from 'emoji-picker-react/dist/data/emojis-pt.json';

export const EMOJI_CATEGORIES_PT = [
  { category: Categories.SUGGESTED, name: 'Usados recentemente' },
  { category: Categories.SMILEYS_PEOPLE, name: 'Carinhas e pessoas' },
  { category: Categories.ANIMALS_NATURE, name: 'Animais e natureza' },
  { category: Categories.FOOD_DRINK, name: 'Comidas e bebidas' },
  { category: Categories.TRAVEL_PLACES, name: 'Viagens e lugares' },
  { category: Categories.ACTIVITIES, name: 'Atividades' },
  { category: Categories.OBJECTS, name: 'Objetos' },
  { category: Categories.SYMBOLS, name: 'Símbolos' },
  { category: Categories.FLAGS, name: 'Bandeiras' },
];

export const EMOJI_SEARCH_PLACEHOLDER_PT = 'Buscar emoji';
export const EMOJI_SEARCH_CLEAR_LABEL_PT = 'Limpar';
