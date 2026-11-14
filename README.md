# WhatsApp Chat - Backend Python

Sistema completo de chat WhatsApp com FastAPI + MySQL + WebSocket para integração com WooCommerce.

## **Índice**

- [Características](#características)
- [Tecnologias](#tecnologias)
- [Pré-requisitos](#pré-requisitos)
- [Instalação Localhost](#instalação-localhost)
- [Configuração](#configuração)
- [Uso](#uso)
- [Deploy Railway](#deploy-railway)
- [API Endpoints](#api-endpoints)
- [Integração WooCommerce](#integração-woocommerce)
- [Troubleshooting](#troubleshooting)

---

## **Características**

**Mensagens WhatsApp Completas**
- Texto, imagens, vídeos, áudios, documentos, stickers
- Upload e download de mídia
- Mensagens template (notificações)
- Localização

**Chat em Tempo Real**
- WebSocket (Socket.IO)
- Notificações instantâneas
- Sincronização automática

**Banco de Dados MySQL**
- Persistência de conversas e mensagens
- Histórico completo
- Otimizado com índices

**API REST Completa**
- Documentação automática (Swagger)
- Validação de dados (Pydantic)
- Tratamento de erros

**Pronto para Produção**
- Deploy Railway fácil
- Docker incluído
- Variáveis de ambiente configuráveis

---

## **Tecnologias**

| Tecnologia | Versão | Descrição |
|------------|--------|-----------|
| Python | 3.11+ | Linguagem principal |
| FastAPI | 0.115+ | Framework web assíncrono |
| SQLAlchemy | 2.0+ | ORM para banco de dados |
| MySQL | 8.0+ | Banco de dados relacional |
| Socket.IO | 5.11+ | WebSocket em tempo real |
| Pydantic | 2.10+ | Validação de dados |
| Uvicorn | 0.32+ | Servidor ASGI |

---

## **Pré-requisitos**

### **Localhost:**
- Python 3.8 ou superior
- MySQL 8.0 ou superior
- pip (gerenciador de pacotes Python)

### **Produção (Railway):**
- Conta no Railway (https://railway.app)
- Conta WhatsApp Business API (https://business.facebook.com)

---

## **Instalação Localhost**

### **1. Clone o Repositório**
```bash
git clone <seu-repositorio>
cd whatsapp-chat-python
```

### **2. Execute o Script de Setup**
```bash
python setup_localhost.py
```

Este script irá:
- Verificar Python e MySQL
- Criar arquivo `.env`
- Instalar dependências
- Criar diretórios necessários

### **3. Configure o Banco de Dados**

#### **Opção A: Via MySQL Command Line**
```bash
mysql -u root -p < scripts/create_database.sql
```

#### **Opção B: Via MySQL Workbench**
1. Abra MySQL Workbench
2. Conecte ao servidor
3. Copie e execute o conteúdo de `scripts/create_database.sql`

### **4. Configure o .env**

Edite o arquivo `.env` e preencha:

```env
# WhatsApp API
WA_PHONE_NUMBER_ID=sua_phone_number_id
CLOUD_API_ACCESS_TOKEN=seu_access_token
WA_BUSINESS_ACCOUNT_ID=seu_business_account_id

# MySQL
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=sua_senha_mysql
DB_NAME=whatsapp_chat

# Webhook
WEBHOOK_VERIFY_TOKEN=seu_token_secreto_qualquer
```

### **5. Inicie o Servidor**
```bash
python app.py
```

Ou com auto-reload:
```bash
uvicorn app:app --reload
```

### **6. Acesse a Documentação**
```
http://localhost:8000/docs
```

---

## **Configuração**

### **Obter Credenciais WhatsApp**

1. **Acesse:** https://business.facebook.com/
2. **Crie um App Business**
3. **Adicione WhatsApp Product**
4. **Copie:**
   - Phone Number ID
   - Access Token (permanente)
   - Business Account ID

### **Configurar Webhook no Meta**

1. **Acesse:** Meta Dashboard > WhatsApp > Configuration
2. **Configure:**
   - **URL:** `https://seu-dominio.com/webhook`
   - **Verify Token:** (valor do `WEBHOOK_VERIFY_TOKEN` do `.env`)
3. **Subscreva:** `messages` e `message_status`

---

## **Uso**

### **Enviar Mensagem de Texto**
```bash
curl -X POST http://localhost:8000/send \
  -F "to=5544999999999" \
  -F "text=Olá, teste!"
```

### **Enviar Imagem**
```bash
curl -X POST http://localhost:8000/send \
  -F "to=5544999999999" \
  -F "type=image" \
  -F "media=@caminho/para/imagem.jpg" \
  -F "caption=Legenda da imagem"
```

### **Listar Conversas**
```bash
curl http://localhost:8000/conversations
```

### **WebSocket (Frontend)**
```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:8000');

socket.on('connect', () => {
  console.log('Conectado!');
});

socket.on('conversation_update', (data) => {
  console.log('Nova mensagem:', data);
});
```

---

## **Deploy Railway**

### **1. Prepare o Projeto**

Certifique-se que tem:
- `Dockerfile`
- `railway.toml`
- `.dockerignore`
- `requirements.txt`

### **2. Crie Projeto no Railway**

```bash
# Instale Railway CLI
npm install -g @railway/cli

# Login
railway login

# Inicie projeto
railway init

# Link ao projeto
railway link
```

### **3. Adicione MySQL**

No Railway Dashboard:
1. Click "New" > "Database" > "MySQL"
2. Railway cria automaticamente `DATABASE_URL`

### **4. Configure Variáveis de Ambiente**

No Railway Dashboard > Variables:
```
WA_PHONE_NUMBER_ID=...
CLOUD_API_ACCESS_TOKEN=...
WA_BUSINESS_ACCOUNT_ID=...
WEBHOOK_VERIFY_TOKEN=...
SECRET_KEY=gere-uma-chave-secreta
CORS_ORIGINS=https://seu-frontend.com
```

### **5. Deploy**
```bash
railway up
```

### **6. Configure Webhook no Meta**

Use a URL do Railway: `https://seu-app.railway.app/webhook`

---

## **API Endpoints**

### **Saúde**
```
GET  /health
GET  /api/info
GET  /api/config
```

### **Conversas**
```
GET  /conversations
POST /mark_messages_read
```

### **Mensagens**
```
POST /send
POST /send_template
```

### **Mídia**
```
GET  /proxy_media/{media_id}
```

### **Webhook**
```
GET  /webhook  (verificação)
POST /webhook  (receber mensagens)
```

### **Documentação Interativa**
```
GET  /docs      (Swagger UI)
GET  /redoc     (ReDoc)
```

---

## **Integração WooCommerce**

### **Plugin WooCommerce (Em Desenvolvimento)**

O sistema está preparado para integração com WooCommerce.

**Tabela disponível:** `woocommerce_orders`

**Próximas features:**
- Notificação automática de pedidos
- Status de entrega
- Confirmação de pagamento
- Chat direto do produto

---

## **Troubleshooting**

### **Erro: Conexão MySQL**
```
Database connection failed
```
**Solução:**
- Verifique se MySQL está rodando: `sudo service mysql status`
- Confirme credenciais no `.env`
- Teste: `mysql -u root -p`

### **Erro: WhatsApp API**
```
401 Unauthorized
```
**Solução:**
- Verifique `CLOUD_API_ACCESS_TOKEN` no `.env`
- Certifique-se que o token não expirou
- Regere token permanente no Meta Dashboard

### **Erro: Webhook não recebe mensagens**
```
Webhook não responde
```
**Solução:**
- Verifique URL pública do webhook
- Confirme `WEBHOOK_VERIFY_TOKEN` no Meta
- Use ngrok para testar localmente:
  ```bash
  ngrok http 8000
  ```

### **Erro: Porta já em uso**
```
Port 8000 already in use
```
**Solução:**
```bash
# Matar processo na porta
sudo lsof -t -i:8000 | xargs kill -9

# Ou usar outra porta
APP_PORT=8080 python app.py
```

---

## **Estrutura do Projeto**

```
whatsapp-chat-python/
├── app.py                          # Aplicação principal
├── requirements.txt                # Dependências
├── Dockerfile                      # Container Docker
├── railway.toml                    # Config Railway
├── setup_localhost.py              # Script de setup
├── .env.example                    # Template de ambiente
│
├── backend/
│   ├── api/
│   │   ├── routes.py              # Endpoints REST
│   │   └── websocket.py           # WebSocket handler
│   │
│   ├── database/
│   │   └── connection.py          # Conexão MySQL
│   │
│   ├── models/
│   │   ├── database_models.py     # Modelos ORM
│   │   └── schemas.py             # Schemas Pydantic
│   │
│   └── services/
│       ├── whatsapp_service.py    # WhatsApp API
│       ├── conversation_service.py # Lógica conversas
│       └── webhook_handler.py     # Processar webhooks
│
└── scripts/
    └── create_database.sql        # Script SQL
```

---

## **Contribuindo**

Contribuições são bem-vindas!

1. Fork o projeto
2. Crie uma branch (`git checkout -b feature/nova-feature`)
3. Commit (`git commit -m 'Add nova feature'`)
4. Push (`git push origin feature/nova-feature`)
5. Abra um Pull Request

---

## **Segurança**

- Rotas de usuário exigem JWT (`get_current_user`) ou permissão específica.
- Webhook da Meta valida `X-Hub-Signature-256` com `M4D_APP_SECRET`.
- Chamadas dos bridges (`/api/webhook/bridge*`, `/api/media/bridge-upload`) usam o segredo compartilhado `BRIDGE_SHARED_SECRET` (header `X-Bridge-Secret`). Sem a variável o backend aceita e registra um aviso: defina-a em produção.
- CORS por `CORS_ORIGINS`; chat do site usa chave por conta.

---

## **Licença**

Todos os direitos reservados. Código publicado apenas para consulta e avaliação; veja o arquivo [LICENSE](LICENSE).

---

### **Componentes de terceiros**

- `frontend/src/services/wa-web-bridge/patches/whatsapp-web.js+1.34.7.patch`: patch aplicado via `patch-package` sobre a biblioteca [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) (Apache-2.0, copyright dos autores originais). O patch contém trechos do código dela e continua sob a licença Apache-2.0; as alterações são minhas, o restante da biblioteca não.
- As demais bibliotecas (Baileys, WPPConnect, React, FastAPI etc.) são instaladas como dependências e mantêm as próprias licenças.

---

## **Suporte**

- **Documentação API:** `/docs`
- **WhatsApp Business API:** https://developers.facebook.com/docs/whatsapp
- **FastAPI Docs:** https://fastapi.tiangolo.com
- **Railway Docs:** https://docs.railway.app

---

## **Checklist de Deploy**

- [ ] Python 3.8+ instalado
- [ ] MySQL configurado e rodando
- [ ] Arquivo `.env` configurado
- [ ] Banco de dados criado
- [ ] Servidor rodando localmente
- [ ] Webhook configurado no Meta
- [ ] Testes de envio funcionando
- [ ] Railway configurado (produção)
- [ ] Frontend integrado

---

**Desenvolvido com usando Python + FastAPI**