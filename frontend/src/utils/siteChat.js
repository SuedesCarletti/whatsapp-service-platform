// Contatos do canal "Chat do Site" (plugin WooCommerce) têm wa_id sintético
// "site<conta>x<hex>@site.chat" — nunca é um telefone, não deve ser exibido.
export const isSiteChatId = (id) => typeof id === 'string' && id.endsWith('@site.chat');

export const isSiteChatContact = (contact) =>
  !!contact && (isSiteChatId(contact.wa_id) || isSiteChatId(contact.phone_number));

export const SITE_CHAT_LABEL = 'Chat do site';
