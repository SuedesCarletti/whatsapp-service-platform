"""
bridge_watchdog.py — reconexão automática de sessões de bridge não-oficial.

Bridges não-oficiais (Baileys/Venom/WPPConnect/WA-Web) podem perder a sessão
em memória (browser/client puppeteer morre em silêncio, ou o Baileys esgota
suas tentativas internas de reconexão) SEM o WhatsApp de fato desvincular o
dispositivo — o token salvo continua válido, só falta alguém chamar
/session/init de novo pra reatar. Confirmado ao vivo em 2026-08-20: a conta
WPPConnect "ti01" ficou presa em authenticated=False por quase 1h sem
nenhuma automação notar/corrigir, porque a única checagem periódica que já
existia (AccountSwitcher.js no front, a cada 25s) é só leitura
(GET /session/status) — nunca chama /session/init pra reconectar de
verdade, e o único outro lugar do código que chama initialize_session() é a
tela de vincular conta nova via QR. Esse watchdog fecha essa lacuna: roda em
background desde o startup do FastAPI, sem depender de ninguém com o app
aberto no navegador.

Política: só tenta reconectar quando authenticated=False E status não é
"qr_required" — nesse caso precisa mesmo de um humano escaneando o QR,
chamar /session/init de novo só regeneraria o QR à toa sem ajudar. Chamar
/session/init em cada bridge é idempotente quando um client ainda existe
pros bridges baseados em puppeteer/browser (não cria uma segunda aba — ver
comentário em cada index.js). NÃO confirmado pra Baileys: incidente
2026-09-11 mostrou uma sessão Baileys de fallback recém-criada (nunca
pareada de verdade) entrando num loop de "440 connectionReplaced" a cada
~30s — plausível que reconexões concorrentes (a própria lógica de retry do
bridge Node + esse watchdog insistindo em paralelo) tenham contribuído. Daí
o circuit breaker (MAX_CONSECUTIVE_FAILURES) abaixo: depois de algumas
tentativas seguidas sem sucesso, para de insistir sozinho.
"""
import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor

from backend.database.connection import SessionLocal
from backend.database.models import WhatsAppAccount
from backend.providers.factory import get_unofficial_provider, normalize_provider_type, UNOFFICIAL_PROVIDER_TYPES

logger = logging.getLogger(__name__)

CHECK_INTERVAL_S = 60
# Estados em que reconectar sozinho não ajuda — precisa de ação humana (ler QR).
SKIP_STATUSES = {"qr_required"}
# Depois de N tentativas seguidas sem sucesso, para de chamar initialize_session
# pra essa conta (circuit breaker) — ver comentário em _check_and_heal_account.
MAX_CONSECUTIVE_FAILURES = 5

# Incidente 2026-09-11: esse loop fazia `db.query(...).all()` SÍNCRONO direto
# dentro da coroutine — trava o event loop inteiro (único worker) pelo tempo
# da query. Sob condição normal é instantâneo, mas junto com o resto deste
# incidente (initialize_session ficando pendurado pra sessões Baileys nunca
# pareadas — ver MAX_CONSECUTIVE_FAILURES acima) contribuiu pra travar TODO
# o /api/health e demais rotas por ~6min até o restart manual. Mesma classe
# de bug já corrigida uma vez em routes_bridge.py (WEBHOOK_EXECUTOR) — não
# reusa aquele por ser um pool grande dedicado a webhook; aqui só 1 query
# leve a cada 60s, um pool próprio e pequeno já isola do resto.
_WATCHDOG_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="bridge-watchdog")
# Contagem de falhas consecutivas por account_id — reseta ao autenticar.
_consecutive_failures: dict = {}


def _fetch_active_accounts_sync():
    db = SessionLocal()
    try:
        return db.query(WhatsAppAccount).filter(WhatsAppAccount.is_active == True).all()
    finally:
        db.close()


async def _fetch_active_accounts():
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_WATCHDOG_EXECUTOR, _fetch_active_accounts_sync)


def _build_provider(account: WhatsAppAccount):
    provider_str = normalize_provider_type(account.provider_type)
    if provider_str not in UNOFFICIAL_PROVIDER_TYPES:
        return None, provider_str

    raw = account.provider_config or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            raw = {}
    config = dict(raw)
    config.setdefault("session_id", account.session_id or "default")
    return get_unofficial_provider(provider_str, config), provider_str


async def _check_and_heal_account(account: WhatsAppAccount) -> None:
    provider, provider_str = _build_provider(account)
    if provider is None:
        return

    try:
        status = await provider.get_session_status()
    except Exception as exc:
        logger.warning(f"[BridgeWatchdog] Falha ao checar status da conta #{account.id} ({provider_str}): {exc}")
        return

    if status.get("authenticated"):
        _consecutive_failures.pop(account.id, None)
        return
    if status.get("status") in SKIP_STATUSES:
        return

    # Circuit breaker (incidente 2026-09-11): contas Baileys de fallback
    # criadas mas nunca pareadas de verdade ficam presas em "starting" pra
    # sempre — sem isso, o watchdog chamava /session/init nelas a cada 60s
    # pra sempre, e cada chamada podia ficar pendurada dezenas de segundos
    # (bridge Node com o socket num estado ruim), empilhando trabalho e
    # ajudando a travar o processo inteiro. Depois de MAX_CONSECUTIVE_FAILURES
    # tentativas seguidas sem sucesso, para de insistir sozinho — precisa de
    # ação humana (parear via QR/pairing code, ou reativar/desativar a conta)
    # pra sair desse estado.
    failures = _consecutive_failures.get(account.id, 0)
    if failures >= MAX_CONSECUTIVE_FAILURES:
        return

    logger.warning(
        f"[BridgeWatchdog] Conta #{account.id} ({provider_str}) desconectada "
        f"(status={status.get('status')}) — tentando reconectar via /session/init "
        f"(tentativa {failures + 1}/{MAX_CONSECUTIVE_FAILURES})"
    )
    succeeded = False
    try:
        result = await provider.initialize_session()
        logger.info(f"[BridgeWatchdog] Conta #{account.id}: initialize_session -> {result}")
        succeeded = result.get("status") == "authenticated"
    except Exception as exc:
        logger.warning(f"[BridgeWatchdog] Falha ao reconectar conta #{account.id}: {exc}")

    if succeeded:
        _consecutive_failures.pop(account.id, None)
        return

    _consecutive_failures[account.id] = failures + 1
    if _consecutive_failures[account.id] == MAX_CONSECUTIVE_FAILURES:
        logger.error(
            f"[BridgeWatchdog] Conta #{account.id} ({provider_str}) atingiu "
            f"{MAX_CONSECUTIVE_FAILURES} falhas seguidas — parando de tentar "
            f"reconectar automaticamente até ação manual."
        )


async def run_bridge_watchdog():
    logger.info(f"[BridgeWatchdog] Iniciado — verificação a cada {CHECK_INTERVAL_S}s")
    while True:
        try:
            accounts = await _fetch_active_accounts()

            for account in accounts:
                await _check_and_heal_account(account)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(f"[BridgeWatchdog] Erro no ciclo de verificação: {exc}", exc_info=True)

        await asyncio.sleep(CHECK_INTERVAL_S)
