import sys
import os
sys.path.append(os.getcwd())
from backend.database.session import SessionLocal
from backend.database.models import Contact, Message, Conversation

db = SessionLocal()
contacts = db.query(Contact).filter(Contact.wa_id.like("1203634%")).all()
for c in contacts:
    print(f"Contact ID: {c.id} | wa_id: {c.wa_id} | name: {c.name}")
    conv = db.query(Conversation).filter(Conversation.contact_id == c.id).first()
    if conv:
        msgs = db.query(Message).filter(Message.conversation_id == conv.id).count()
        print(f"  -> Conv ID: {conv.id} | Msgs: {msgs}")
