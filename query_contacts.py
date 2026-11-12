import sys
import os
sys.path.append(os.getcwd())
from backend.database.session import SessionLocal
from backend.database.models import Contact

db = SessionLocal()
contacts = db.query(Contact).filter(Contact.wa_id.like("120363426670783561%")).all()
for c in contacts:
    print(f"ID: {c.id}, WA_ID: {c.wa_id}, NAME: {c.name}")
