"""
Nome de exibição escolhível — como o nome de uma pessoa aparece pro cliente
(prefixo de identidade nas mensagens de texto, backend/api/routes.py e
routes_broadcast.py) e pra equipe (nome do remetente no chat interno,
backend/api/routes_internal_chat.py). Ponto único de formatação — antes
disso existiam 3 cópias quase idênticas de "pega só o primeiro nome" nesses
arquivos, sem nenhuma escolha da pessoa.
"""
from typing import Optional

DISPLAY_NAME_FORMATS = ("first_initial", "initial_last", "none")
DEFAULT_DISPLAY_NAME_FORMAT = "first_initial"


def format_display_name(full_name: Optional[str], email: str, fmt: Optional[str]) -> str:
    """
    fmt="first_initial" -> "João S."  (primeiro nome + inicial do sobrenome)
    fmt="initial_last"  -> "J. Silva" (inicial do primeiro nome + sobrenome)
    fmt ausente/desconhecido -> trata como o default ("first_initial").
    Sem full_name -> usa a parte antes do @ do email (mesmo fallback que já
    existia nos 3 lugares que este módulo substitui).
    Nome de uma palavra só (sem sobrenome pra abreviar) -> devolve como está,
    não dá pra aplicar nenhum dos dois formatos.
    """
    name = (full_name or "").strip() or (email or "").split("@")[0]
    parts = name.split()
    if len(parts) < 2:
        return name

    first, last = parts[0], parts[-1]
    # "none" so desliga o prefixo pro cliente (build_identity_prefix); onde um
    # nome ainda e necessario (chat interno) cai no formato default.
    if fmt not in DISPLAY_NAME_FORMATS or fmt == "none":
        fmt = DEFAULT_DISPLAY_NAME_FORMAT

    if fmt == "initial_last":
        return f"{first[0]}. {last}"
    return f"{first} {last[0]}."


def build_identity_prefix(full_name: Optional[str], email: str, fmt: Optional[str], sector: Optional[str]) -> str:
    """
    Prefixo de identidade das mensagens de texto pro cliente: "*Nome - Setor*"
    (ou so "*Nome*" sem setor) + quebra de linha. Devolve "" quando a pessoa
    desativou o nome de exibicao (fmt="none"): a mensagem vai sem prefixo.
    """
    if fmt == "none":
        return ""
    name = format_display_name(full_name, email, fmt)
    sector = (sector or "").strip()
    return (f"*{name} - {sector}*" if sector else f"*{name}*") + "\n"
