# Quick Start - WhatsApp Chat Backend

Guia rápido para começar em **5 minutos**! 

---

## **Pré-requisitos**

- Python 3.8+ instalado
- MySQL 8.0+ rodando
- Credenciais WhatsApp Business API

---

## **Setup Rápido (Localhost)**

### **1. Clone e Entre no Diretório**
```bash
git clone <seu-repositorio>
cd whatsapp-chat-python
```

### **2. Execute o Setup Automático**
```bash
python setup_localhost.py
```

### **3. Configure o .env**

Edite o arquivo `.env` e preencha o mínimo necessário:

```env
# WhatsApp (obrigatório)
WA_PHONE_NUMBER_ID=seu_phone_number_id_aqui
CLOUD_API_ACCESS_TOKEN=seu_token_aqui

# MySQL (obrigatório)
DB_PASSWORD=sua_senha_mysql

# Webhook (obrigatório)
WEBHOOK_VERIFY_TOKEN=qualquer_texto_secreto_aqui
```

### **4. Crie o Banco de Dados**
```bash
mysql -u root -p < scripts/create_database.sql
```

### **5. Inicie o Servidor**
```bash
# Opção 1: Script pronto
./start.sh

# Opção 2: Comando direto
python app.py

# Opção 3: Com auto-reload (dev)
uvicorn app:app --reload
```

### **6. Teste!**
```
API: http://localhost:8000
Docs: http://localhost:8000/docs
Health: http://localhost:8000/health
```

---

## **Teste Rápido**

### **Enviar Mensagem de Texto**
```bash
curl -X POST http://localhost:8000/send \
  -F "to=5544999999999" \
  -F "text=Olá! Teste do WhatsApp Chat"
```

### **Ver Conversas**
```bash
curl http://localhost:8000/conversations
```

---

## **Obter Credenciais WhatsApp**

1. Acesse: https://business.facebook.com/
2. Crie um App Business
3. Adicione produto "WhatsApp"
4. Copie:
   - **Phone Number ID** → `WA_PHONE_NUMBER_ID`
   - **Access Token** → `CLOUD_API_ACCESS_TOKEN`
   - **Business Account ID** → `WA_BUSINESS_ACCOUNT_ID`

---

## **Configurar Webhook (Meta)**

### **Localhost (para testes)**
```bash
# Instale ngrok
brew install ngrok  # macOS
# ou baixe em: https://ngrok.com

# Exponha localhost
ngrok http 8000

# Use a URL gerada (ex: https://abc123.ngrok.io/webhook)
```

### **No Meta Dashboard**
1. Vá em: WhatsApp > Configuration
2. Configure webhook:
   - **URL:** `https://sua-url.ngrok.io/webhook`
   - **Verify Token:** (valor do `WEBHOOK_VERIFY_TOKEN`)
3. Subscribe em: `messages`, `message_status`

---

## **Deploy Railway (Produção)**

### **Setup Rápido**
```bash
# 1. Instale Railway CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. Deploy
railway up
```

### **Configure no Railway Dashboard**
- Adicione MySQL (Database > Add > MySQL)
- Configure variáveis de ambiente
- Copie a URL do app e configure no Meta

---

## **Problemas Comuns**

### **MySQL Connection Failed**
```bash
# Inicie o MySQL
sudo service mysql start

# Verifique se está rodando
sudo service mysql status
```

### **Port Already in Use**
```bash
# Mude a porta no .env
APP_PORT=8080

# Ou mate o processo
sudo lsof -t -i:8000 | xargs kill -9
```

### **WhatsApp 401 Unauthorized**
- Verifique se o token está correto no `.env`
- Gere um token permanente no Meta Dashboard

---

## **Próximos Passos**

- [ ] Leia o [README.md](README.md) completo
- [ ] Explore a [documentação](http://localhost:8000/docs)
- [ ] Configure webhook no Meta
- [ ] Teste envio de imagens e vídeos
- [ ] Integre com seu frontend

---

## **Dicas**

Use ambiente virtual Python:
```bash
python -m venv venv
source venv/bin/activate  # Linux/Mac
venv\Scripts\activate     # Windows
```

Modo desenvolvimento (auto-reload):
```bash
./start.sh --reload
```

Ver logs em tempo real:
```bash
tail -f logs/app.log
```

---

## **Comandos Úteis**

```bash
# Instalar dependências
pip install -r requirements.txt

# Rodar testes (quando implementados)
pytest

# Formatar código
black .

# Verificar código
flake8 backend/

# Criar migration (quando usar Alembic)
alembic revision --autogenerate -m "descrição"
alembic upgrade head
```

---

**Pronto! Seu backend WhatsApp está funcionando!** 

Para mais detalhes, consulte o [README.md](README.md) completo.