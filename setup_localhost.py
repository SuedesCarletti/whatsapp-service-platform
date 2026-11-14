#!/usr/bin/env python3
"""
Script de setup para configurar o projeto no localhost
Execute: python setup_localhost.py
"""
import os
import sys
import subprocess
from pathlib import Path
import shutil


def print_header(text):
    """Imprime cabeçalho formatado"""
    print("\n" + "="*60)
    print(f"  {text}")
    print("="*60 + "\n")


def check_python_version():
    """Verifica versão do Python"""
    print_header("Verificando Python")
    
    if sys.version_info < (3, 8):
        print("Python 3.8 ou superior é necessário!")
        print(f"   Versão atual: {sys.version}")
        sys.exit(1)
    
    print(f"Python {sys.version_info.major}.{sys.version_info.minor} detectado")


def create_env_file():
    """Cria arquivo .env a partir do .env.example"""
    print_header("Configurando .env")
    
    if Path(".env").exists():
        response = input("⚠️  Arquivo .env já existe. Sobrescrever? (s/N): ")
        if response.lower() != 's':
            print("⏭ Pulando criação do .env")
            return
    
    # Copiar .env.example para .env
    shutil.copy(".env.example", ".env")
    print("Arquivo .env criado!")
    print("\nIMPORTANTE: Edite o arquivo .env e configure:")
    print("   1. WA_PHONE_NUMBER_ID")
    print("   2. CLOUD_API_ACCESS_TOKEN")
    print("   3. WA_BUSINESS_ACCOUNT_ID")
    print("   4. DB_PASSWORD (senha do MySQL)")
    print("   5. WEBHOOK_VERIFY_TOKEN")
    
    input("\n⏸️  Pressione ENTER depois de configurar o .env...")


def check_mysql():
    """Verifica se MySQL está instalado e rodando"""
    print_header("Verificando MySQL")
    
    try:
        result = subprocess.run(
            ["mysql", "--version"],
            capture_output=True,
            text=True,
            check=True
        )
        print("MySQL instalado:", result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("MySQL não encontrado!")
        print("\nInstale o MySQL:")
        print("   Ubuntu/Debian: sudo apt-get install mysql-server")
        print("   macOS: brew install mysql")
        print("   Windows: https://dev.mysql.com/downloads/installer/")
        sys.exit(1)


def install_dependencies():
    """Instala dependências Python"""
    print_header("Instalando Dependências Python")
    
    print("Instalando pacotes do requirements.txt...")
    
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"],
            check=True
        )
        print("Dependências instaladas com sucesso!")
    except subprocess.CalledProcessError:
        print("Erro ao instalar dependências!")
        sys.exit(1)


def setup_database():
    """Configura banco de dados"""
    print_header("Configurando Banco de Dados")
    
    print(" Criando banco de dados...")
    print("\nExecute o seguinte comando no MySQL:")
    print("   mysql -u root -p < scripts/create_database.sql")
    print("\nOu copie e cole o conteúdo de scripts/create_database.sql no MySQL Workbench")
    
    response = input("\nBanco de dados criado? (s/N): ")
    if response.lower() == 's':
        print("Banco de dados configurado!")
    else:
        print(" Configure o banco de dados antes de continuar")


def create_uploads_dir():
    """Cria diretório de uploads"""
    print_header("Criando Diretórios")
    
    Path("uploads").mkdir(exist_ok=True)
    print("Diretório 'uploads' criado!")


def print_final_instructions():
    """Imprime instruções finais"""
    print_header("Setup Concluído! ")
    
    print("Próximos Passos:\n")
    print("1⃣  Configure suas credenciais do WhatsApp no arquivo .env")
    print("    - Acesse: https://business.facebook.com/")
    print("    - Obtenha: PHONE_NUMBER_ID e ACCESS_TOKEN\n")
    
    print("2⃣  Execute o banco de dados:")
    print("    mysql -u root -p < scripts/create_database.sql\n")
    
    print("3⃣  Inicie o servidor:")
    print("    python app.py")
    print("    ou")
    print("    uvicorn app:app --reload\n")
    
    print("4⃣  Acesse a documentação:")
    print("    http://localhost:8000/docs\n")
    
    print("5⃣  Configure o webhook no Meta:")
    print("    URL: https://seu-dominio.com/webhook")
    print("    Token: (valor de WEBHOOK_VERIFY_TOKEN do .env)\n")
    
    print("Documentação completa no README.md")
    print("Dúvidas? Verifique o arquivo .env.example\n")


def main():
    """Executa setup completo"""
    print("\n" + ""*15)
    print("   WhatsApp Chat - Setup Localhost")
    print(""*15)
    
    # Verificações
    check_python_version()
    check_mysql()
    
    # Configurações
    create_env_file()
    install_dependencies()
    create_uploads_dir()
    setup_database()
    
    # Finalizar
    print_final_instructions()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nSetup cancelado pelo usuário")
        sys.exit(1)
    except Exception as e:
        print(f"\n\nErro durante setup: {e}")
        sys.exit(1)