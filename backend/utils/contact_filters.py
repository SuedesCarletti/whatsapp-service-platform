"""
Wa_ids de contatos "fantasma" criados pelos bridges pra eventos que não são
mensagem de cliente de verdade — não tem ninguém do outro lado pra
responder, não deveriam contar em fila/métrica de atendimento nem aparecer
na lista de conversas real:

- status@broadcast: Status/Stories do WhatsApp (vira Conversation normal se
  não filtrada; tratado à parte via GET /api/statuses).
- wppconnect-reaction: placeholder usado por onReactionMessage no bridge
  WPPConnect (o evento de reação não traz o chat/remetente de verdade).

Fonte única — usado tanto na ingestão (webhook_handler.py, pra não disparar
automação nesses contatos) quanto nas listagens/dashboard (conversation_
service.py, routes_admin.py), pra não haver o risco de listar num lugar e
esquecer o outro.
"""
NON_CUSTOMER_WA_IDS = {"status@broadcast", "wppconnect-reaction"}
