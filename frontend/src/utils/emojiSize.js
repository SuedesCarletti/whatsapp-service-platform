/**
 * emojiSize — detecta mensagem "só emoji" (igual WhatsApp: 1-3 emojis sozinhos,
 * sem nenhum outro texto, renderizam bem maiores que uma mensagem normal).
 * Usado tanto no chat de clientes (ChatArea.js) quanto no chat de equipe
 * (InternalChatArea.js) — por isso vive em utils, não duplicado nos dois.
 *
 * \p{Extended_Pictographic} cobre a faixa Unicode de emoji; é o
 * seletor de variação (emoji vs texto, ex: coração cheio vs contorno);
 * é o Zero-Width-Joiner que junta vários emoji num só grafema (ex:
 * familia = pessoa+ZWJ+pessoa+ZWJ+crianca). Sem cobrir isso, um emoji
 * "combinado" contaria como 3+ e nunca bateria o teto de "poucos emoji".
 */
const EMOJI_CLUSTER = /\p{Extended_Pictographic}(️)?(‍\p{Extended_Pictographic}(️)?)*/gu;
const ONLY_EMOJI_AND_SPACE = /^(\p{Extended_Pictographic}(️)?(‍\p{Extended_Pictographic}(️)?)*|\s)+$/u;

// Teto de 3: igual ao comportamento real do WhatsApp — 1 a 3 emojis sozinhos
// ficam grandes, 4 ou mais volta pro tamanho normal de texto.
const MAX_EMOJI_FOR_LARGE = 3;

/**
 * Retorna a classe CSS a aplicar no balão de texto ("emoji-only-message"),
 * ou string vazia se a mensagem não é só emoji (ou tem emoji demais).
 */
export function emojiOnlyClass(text) {
  if (!text) return '';
  const trimmed = text.trim();
  if (!trimmed || !ONLY_EMOJI_AND_SPACE.test(trimmed)) return '';
  const count = (trimmed.match(EMOJI_CLUSTER) || []).length;
  if (count === 0 || count > MAX_EMOJI_FOR_LARGE) return '';
  return 'emoji-only-message';
}
