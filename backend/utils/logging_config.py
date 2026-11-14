"""
Configuração de Logging Otimizada para Railway
Corrige problema de todos os logs aparecerem como ERROR no Railway Dashboard
"""
import logging
import sys
import os
from pathlib import Path
import json
from datetime import datetime

# Cores para terminal (desabilitadas em produção/Railway)
COLORS_ENABLED = os.getenv("ENVIRONMENT", "production") == "development"

class ColoredFormatter(logging.Formatter):
    """Formatter com cores para terminal (só em dev)"""
    
    COLORS = {
        'DEBUG': '\033[36m',     # Cyan
        'INFO': '\033[32m',      # Green
        'WARNING': '\033[33m',   # Yellow
        'ERROR': '\033[31m',     # Red
        'CRITICAL': '\033[35m',  # Magenta
    }
    RESET = '\033[0m'
    
    def format(self, record):
        if COLORS_ENABLED:
            color = self.COLORS.get(record.levelname, self.RESET)
            record.levelname = f"{color}{record.levelname}{self.RESET}"
        return super().format(record)


class RailwayFormatter(logging.Formatter):
    """
    Formatter otimizado para Railway
    Usa formato estruturado para melhor parsing
    """
    
    def format(self, record):
        # Criar log estruturado
        log_data = {
            "timestamp": datetime.utcnow().isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        
        # Adicionar informações extras
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)
        
        if hasattr(record, 'user_id'):
            log_data["user_id"] = record.user_id
        
        if hasattr(record, 'request_id'):
            log_data["request_id"] = record.request_id
        
        # Formato Railway-friendly (não JSON em produção para legibilidade)
        # Railway espera: LEVEL | LOGGER | MESSAGE
        return f"{record.levelname:8} | {record.name:30} | {record.getMessage()}"


def setup_logging():
    """
    Configura logging de acordo com o ambiente
    
    Development: Colorido no terminal
    Production/Railway: Formato estruturado para Railway
    """
    
    environment = os.getenv("ENVIRONMENT", "production")
    debug_mode = os.getenv("DEBUG", "False").lower() == "true"
    
    # Nível de log baseado no ambiente
    if debug_mode:
        log_level = logging.DEBUG
    else:
        log_level = logging.INFO
    
    # CONFIGURAÇÃO DO ROOT LOGGER
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    
    # Remover handlers existentes
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)
    
    # HANDLER PARA STDOUT (Railway captura isto)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(log_level)
    
    if environment == "development":
        # Desenvolvimento: Formato colorido
        formatter = ColoredFormatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
    else:
        # Produção/Railway: Formato estruturado
        formatter = RailwayFormatter()
    
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)
    
    # CONFIGURAR NÍVEIS DE LOGGERS ESPECÍFICOS
    
    # Seu app - INFO level
    logging.getLogger('app').setLevel(logging.INFO)
    logging.getLogger('backend').setLevel(logging.INFO)
    logging.getLogger('__main__').setLevel(logging.INFO)
    
    # Bibliotecas externas - WARNING level (reduzir noise)
    logging.getLogger('uvicorn').setLevel(logging.WARNING)
    logging.getLogger('uvicorn.access').setLevel(logging.WARNING)
    logging.getLogger('uvicorn.error').setLevel(logging.WARNING)
    logging.getLogger('fastapi').setLevel(logging.WARNING)
    logging.getLogger('sqlalchemy').setLevel(logging.WARNING)
    logging.getLogger('httpx').setLevel(logging.WARNING)
    logging.getLogger('httpcore').setLevel(logging.WARNING)
    
    # HANDLER PARA ARQUIVO (OPCIONAL)
    if environment == "development":
        # Criar diretório de logs
        log_dir = Path("logs")
        log_dir.mkdir(exist_ok=True)
        
        # Handler para arquivo
        file_handler = logging.FileHandler(
            log_dir / f"app_{datetime.now().strftime('%Y%m%d')}.log"
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        ))
        root_logger.addHandler(file_handler)
    
    # LOG DE INICIALIZAÇÃO
    logger = logging.getLogger(__name__)
    logger.info("=" * 80)
    logger.info("LOGGING CONFIGURADO")
    logger.info(f"   Ambiente: {environment}")
    logger.info(f"   Nível: {logging.getLevelName(log_level)}")
    logger.info(f"   Debug: {debug_mode}")
    logger.info(f"   Handlers: {len(root_logger.handlers)}")
    logger.info("=" * 80)
    
    return root_logger


def get_request_logger(request_id: str = None):
    """
    Retorna logger com context do request
    Útil para tracking de requests específicos
    """
    logger = logging.getLogger('backend.request')
    
    # Adicionar request_id ao logger
    if request_id:
        logger = logging.LoggerAdapter(logger, {'request_id': request_id})
    
    return logger


# UTILITÁRIOS PARA LOGGING ESTRUTURADO

def log_webhook(logger, webhook_type: str, payload: dict):
    """Helper para logar webhooks de forma estruturada"""
    logger.info("=" * 80)
    logger.info(f"WEBHOOK RECEBIDO: {webhook_type}")
    logger.info("=" * 80)
    logger.info(json.dumps(payload, indent=2, ensure_ascii=False))
    logger.info("=" * 80)


def log_api_request(logger, method: str, path: str, status: int, duration_ms: float):
    """Helper para logar requests de API"""
    emoji = "" if 200 <= status < 300 else "❌"
    logger.info(f"{emoji} {method:6} {path:40} {status} ({duration_ms:.2f}ms)")


def log_error_with_context(logger, error: Exception, context: dict = None):
    """Helper para logar erros com contexto adicional"""
    logger.error(f"Erro: {str(error)}")
    if context:
        logger.error(f"   Contexto: {json.dumps(context, indent=2)}")
    logger.error(f"   Tipo: {type(error).__name__}", exc_info=True)


# CONFIGURAÇÃO PARA UVICORN

def get_uvicorn_log_config():
    """
    Retorna configuração de logging para Uvicorn
    Compatível com Railway
    """
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "default": {
                "()": "uvicorn.logging.DefaultFormatter",
                "fmt": "%(levelname)s | %(name)s | %(message)s",
                "use_colors": COLORS_ENABLED,
            },
            "access": {
                "()": "uvicorn.logging.AccessFormatter",
                "fmt": '%(levelname)s | %(client_addr)s | "%(request_line)s" %(status_code)s',
            },
        },
        "handlers": {
            "default": {
                "formatter": "default",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout",
            },
            "access": {
                "formatter": "access",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout",
            },
        },
        "loggers": {
            "uvicorn": {
                "handlers": ["default"],
                "level": "WARNING",  # Reduzir noise
            },
            "uvicorn.error": {
                "level": "WARNING",  # Só warnings e erros
            },
            "uvicorn.access": {
                "handlers": ["access"],
                "level": "WARNING",  # Desabilitar logs de acesso (muito verboso)
                "propagate": False,
            },
        },
    }


# EXEMPLO DE USO

if __name__ == "__main__":
    # Setup
    setup_logging()
    
    # Teste
    logger = logging.getLogger(__name__)
    logger.debug("Mensagem de debug")
    logger.info("ℹ Mensagem informativa")
    logger.warning(" Mensagem de aviso")
    logger.error("Mensagem de erro")
    
    # Teste com contexto
    log_error_with_context(
        logger,
        ValueError("Teste de erro"),
        {"user_id": 123, "action": "test"}
    )
