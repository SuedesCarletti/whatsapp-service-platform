// Cache em memória (dura a sessão do SPA) de fotos de perfil/grupo já buscadas via
// Baileys — evita rebuscar a mesma foto toda vez que a sidebar re-renderiza ou que
// o cabeçalho do chat troca de conversa. Compartilhado entre Sidebar e ChatArea.
// null cacheado = "já tentou e não tem foto", evita retry infinito.
const avatarCache = new Map();

// Providers cujo bridge implementa /profile/picture (mesmo conjunto que o
// backend expõe em _FULL_API_PROVIDERS, routes_baileys.py) — Venom fica de
// fora porque seu envio básico já está quebrado, não faz sentido buscar foto.
// Única fonte de verdade: Sidebar e ChatArea importam daqui pra não divergir
// de novo (o cabeçalho do ChatArea ficou preso em 'baileys' sozinho por um
// tempo enquanto a Sidebar já tinha os três provedores).
export const PHOTO_CAPABLE_PROVIDERS = new Set(['baileys', 'wppconnect', 'whatsapp_web_js']);

export default avatarCache;
