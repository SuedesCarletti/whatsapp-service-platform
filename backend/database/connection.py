"""
Configuração e conexão com o banco de dados MySQL
✅ SUPORTE SSL/TLS FORÇADO para Railway, TiDB Cloud e outros bancos cloud
"""
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from typing import Generator
import os
from dotenv import load_dotenv
import logging
import ssl

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Carregar variáveis de ambiente
load_dotenv()

# Base para os modelos
Base = declarative_base()

# Configurar URL do banco de dados
def get_database_url() -> str:
    """
    Retorna a URL de conexão do banco de dados.
    Suporta tanto configuração via DATABASE_URL (Railway) quanto via variáveis separadas (local)
    """
    database_url = os.getenv("DATABASE_URL")
    
    if database_url:
        # Railway ou outras plataformas que fornecem DATABASE_URL completa
        # Converter postgres:// para postgresql:// se necessário
        if database_url.startswith("postgres://"):
            database_url = database_url.replace("postgres://", "postgresql://", 1)
        
        # Remover parâmetros SSL da URL (vamos adicionar via connect_args)
        if "?" in database_url:
            base_url = database_url.split("?")[0]
            database_url = base_url
        
        return database_url
    
    # Configuração local com variáveis separadas
    db_user = os.getenv("DB_USER", "root")
    db_password = os.getenv("DB_PASSWORD", "")
    db_host = os.getenv("DB_HOST", "localhost")
    db_port = os.getenv("DB_PORT", "3306")
    db_name = os.getenv("DB_NAME", "whatsapp_chat")
    
    return f"mysql+pymysql://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}"


def is_cloud_database(database_url: str) -> bool:
    """
    Detecta se o banco de dados está em ambiente cloud (Railway, TiDB, etc)
    """
    cloud_indicators = [
        "railway", "tidb", "planetscale", "aws", "azure", 
        "gcp", "cloud", ".internal", "pingcap"
    ]
    return any(indicator in database_url.lower() for indicator in cloud_indicators)


# Criar engine do banco com fallback para SQLite temporário
try:
    DATABASE_URL = get_database_url()
    logger.info(f"Tentando conectar ao banco de dados...")
    
    # FORÇAR SSL para bancos cloud
    connect_args = {}
    
    if "mysql" in DATABASE_URL.lower() and is_cloud_database(DATABASE_URL):
        logger.info("Banco cloud detectado - habilitando SSL OBRIGATÓRIO")
        
        # Configuração SSL rigorosa para TiDB/Railway
        connect_args = {
            "ssl": {
                "ssl_mode": "REQUIRED",  # Exigir SSL
                "check_hostname": False,  # Não verificar hostname (evita erros de certificado)
            },
            "charset": "utf8mb4"
        }
    elif "mysql" in DATABASE_URL.lower():
        # MySQL local - sem SSL
        connect_args = {
            "charset": "utf8mb4"
        }
    
    engine = create_engine(
        DATABASE_URL,
        connect_args=connect_args,
        pool_pre_ping=True,  # Verifica conexão antes de usar
        pool_recycle=3600,   # Recicla conexões a cada hora
        # Incidente 2026-09-11: pareamento de conta Baileys fallback gera uma
        # rajada de histórico reenviado — 40 conexões (15+25) esgotaram em
        # segundos, derrubando /api/health e outras rotas por ~1min até o
        # restart. MySQL max_connections=151 tinha sobra de sobra (pico
        # observado ~46 no total do servidor); o teto real era este pool por
        # processo. 20+30=50/processo, prod+teste=100 no pico, ainda com
        # folga sob o limite do servidor.
        pool_size=20,        # Tamanho do pool de conexões
        max_overflow=30,     # Conexões adicionais permitidas (total 50 por processo)
        pool_timeout=10,     # Falha rápido (10s) em vez de travar esperando conexão livre
        echo=os.getenv("DEBUG", "False") == "True"  # Log SQL quando DEBUG=True
    )
    logger.info("Database engine created successfully")
    
except Exception as e:
    logger.warning(f"Failed to create MySQL engine: {e}")
    logger.warning("Using temporary SQLite database (in-memory)")
    logger.warning("Configure DATABASE_URL or DB_* variables to use MySQL")
    logger.warning("")
    logger.warning("=" * 70)
    logger.warning("ATENÇÃO: O banco de dados NÃO está configurado!")
    logger.warning("Configure as variáveis de ambiente no Railway:")
    logger.warning("  DATABASE_URL=mysql://user:pass@host:3306/db")
    logger.warning("  OU")
    logger.warning("  DB_HOST=seu_host")
    logger.warning("  DB_PORT=3306")
    logger.warning("  DB_USER=seu_usuario")
    logger.warning("  DB_PASSWORD=sua_senha")
    logger.warning("  DB_NAME=whatsapp_chat")
    logger.warning("=" * 70)
    logger.warning("")
    
    # Fallback: SQLite temporário em memória (apenas para permitir que o app inicie)
    DATABASE_URL = "sqlite:///:memory:"
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        echo=os.getenv("DEBUG", "False") == "True"
    )

# Criar SessionLocal
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    """
    Dependency para obter sessão do banco de dados.
    Uso:
        @app.get("/items")
        def read_items(db: Session = Depends(get_db)):
            ...
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """
    Inicializa o banco de dados criando todas as tabelas.
    Usar apenas em desenvolvimento ou em primeira execução.
    """
    from backend.models.database_models import Base
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables created successfully!")


def check_db_connection() -> bool:
    """
    Verifica se a conexão com o banco de dados está funcionando.
    Retorna True se conectado, False caso contrário.
    """
    try:
        with engine.connect() as connection:
            # Usar text() para consultas SQL simples (compatibilidade SQLAlchemy 2.0)
            from sqlalchemy import text
            connection.execute(text("SELECT 1"))
        logger.info("Database connection successful!")
        return True
    except Exception as e:
        logger.error(f"Database connection failed: {e}")
        return False
