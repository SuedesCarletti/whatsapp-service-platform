"""
Todo datetime salvo neste app é UTC (datetime.utcnow()/datetime.now() num
servidor cuja timezone do SO é UTC), mas nunca carrega tzinfo — SQLAlchemy
devolve objetos "naive". Serializado direto num dict de resposta, o
FastAPI/jsonable_encoder chama `.isoformat()` sem `Z`/offset nenhum
("2026-08-19T14:14:35"), e o front (moment()/new Date()) interpreta essa
string como horário LOCAL DO NAVEGADOR, não UTC — errando por exatamente o
offset de fuso do navegador (३h a menos no Brasil, por exemplo).

Use `to_utc_iso()` em vez de embutir o datetime cru sempre que um campo
`*_at`/`created_at`/`timestamp` (datetime, não epoch em ms) for entrar numa
resposta de API que o front vai ler com moment()/Date(). Campos já
convertidos pra epoch em milissegundos (`int(dt.timestamp() * 1000)`) não
precisam disso — epoch não tem essa ambiguidade.
"""
from datetime import datetime
from typing import Optional


def to_utc_iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return dt.isoformat() + "Z"
