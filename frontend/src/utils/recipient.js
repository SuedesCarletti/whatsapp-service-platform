/**
 * Resolve o JID de destino para envio de mensagens.
 *
 * Em conversas de grupo, contact.wa_id nem sempre carrega o sufixo @g.us
 * (depende de como/quando o contato do grupo foi criado no banco).
 * conversation.group_jid é a fonte de verdade — sempre a JID completa do
 * grupo — e deve ter prioridade para não gerar uma JID de usuário
 * individual (@s.whatsapp.net) a partir do número numérico do grupo,
 * o que faz o bridge "enviar com sucesso" para um destinatário inexistente.
 */
export function getRecipientJid(conversation) {
  if (!conversation) return null;
  if (conversation.is_group && conversation.group_jid) {
    return conversation.group_jid;
  }
  return conversation.contact?.wa_id || conversation.fromNumber || null;
}
