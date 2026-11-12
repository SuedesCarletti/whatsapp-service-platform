import json, time
import httpx
from backend.database.connection import SessionLocal
from backend.database.models import WhatsAppAccount, Message, Conversation, Contact, User

BASE = "http://localhost:8000/api/webhook"
db = SessionLocal()
user = db.query(User).first()
assert user, "sem usuario"

def mkacc(name, ptype, cfg):
    a = WhatsAppAccount(user_id=user.id, account_name=name, phone_number="5511900000000",
                        provider_type=ptype, provider_config=cfg, is_active=True)
    db.add(a); db.commit(); db.refresh(a); return a

prim = mkacc("TEST-primary", "wppconnect", json.dumps({"session_id": "t-primary"}))
comp = mkacc("TEST-companion", "baileys", json.dumps({"session_id": "t-comp", "fallback_for_account_id": prim.id}))
print("contas", prim.id, comp.id)

now = int(time.time() * 1000)
def msg(wamid, ts, text, direction="inbound"):
    return {"wamid": wamid, "from": "5511988887777" if direction == "inbound" else "me",
            "to": "me" if direction == "inbound" else "5511988887777", "direction": direction,
            "type": "text", "timestamp": ts, "text": text, "contact_name": "Cliente Teste",
            "push_name": "Cliente Teste", "is_group": False}

def post(path, body):
    r = httpx.post(f"{BASE}{path}", json=body, timeout=30)
    return r.status_code, r.json()

res = {}
res["1_primary"] = post("/bridge/sync", {"session_id": "t-primary", "messages": [msg("TST_P1", now - 5000, "do wppconnect")]})
res["2_companion_hist"] = post("/bridge/sync", {"session_id": "t-comp", "messages": [
    msg("TST_P1", now - 5000, "do wppconnect"),          # duplicada
    msg("TST_C1", now - 90000000, "so no baileys (antiga)"),
    msg("TST_C2", now - 80000000, "so no baileys 2", "outbound"),
]})
res["3_companion_catchup"] = post("/bridge/sync", {"session_id": "t-comp", "catchup": True,
                                                   "messages": [msg("TST_C3", now - 1000, "ao vivo atrasada")]})
res["4_companion_live"] = post("/bridge", {**msg("TST_C4", now, "ao vivo"), "session_id": "t-comp", "bridge_provider": "baileys"})
for k, v in res.items():
    print(k, v)

db.commit()  # novo snapshot (REPEATABLE READ): enxerga o que o app gravou
db.expire_all()
convs = db.query(Conversation).filter(Conversation.account_id.in_([prim.id, comp.id])).all()
by_acc = {}
for c in convs:
    by_acc.setdefault(c.account_id, []).append(c.id)
msgs = db.query(Message).filter(Message.wamid.like("TST_%")).all()
wamids = sorted(m.wamid for m in msgs)
checks = [
    ("conversas so na primaria", set(by_acc) == {prim.id} and len(by_acc[prim.id]) == 1),
    ("wamids = P1,C1,C2 (sem dup, sem catchup/live)", wamids == ["TST_C1", "TST_C2", "TST_P1"]),
    ("merged_into == primaria", res["2_companion_hist"][1].get("merged_into") == prim.id),
    ("catchup da companion ignorado", res["3_companion_catchup"][1].get("saved", 0) == 0),
    ("live da companion nao gravou (TST_C4 ausente)", "TST_C4" not in wamids),
]
print("by_acc", by_acc, "wamids", wamids, "msg accounts", sorted({(m.wamid, m.conversation.account_id if m.conversation else None) for m in msgs}))
for n, ok in checks:
    print("OK  " if ok else "FAIL", n)

# limpeza (so o que o teste criou)
conv_ids = list({m.conversation_id for m in msgs} | {c.id for c in convs})
contact_ids = {c.contact_id for c in db.query(Conversation).filter(Conversation.id.in_(conv_ids)).all()}
db.query(Message).filter(Message.conversation_id.in_(conv_ids)).delete(synchronize_session=False)
db.query(Conversation).filter(Conversation.id.in_(conv_ids)).delete(synchronize_session=False)
db.query(Contact).filter(Contact.id.in_(contact_ids)).delete(synchronize_session=False)
db.query(WhatsAppAccount).filter(WhatsAppAccount.id.in_([prim.id, comp.id])).delete(synchronize_session=False)
db.commit()
print("limpeza ok; restantes:", db.query(Message).count(), db.query(Conversation).count(), db.query(Contact).count())
raise SystemExit(0 if all(ok for _, ok in checks) else 1)
