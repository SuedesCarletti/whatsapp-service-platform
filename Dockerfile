# ----------------------------------------------------
# STAGE 1: Frontend Build (Node.js)
# ----------------------------------------------------
FROM node:18-slim AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
# CORREÇÃO: Usar npm install --omit=dev para evitar o erro EUSAGE que exige package-lock.json para 'npm ci'
RUN npm install --omit=dev
COPY frontend/ ./
RUN npm run build


# ----------------------------------------------------
# STAGE 2: Backend Final (Python)
# ----------------------------------------------------
FROM python:3.11-slim AS final

# Configuração de ambiente
ENV PYTHONUNBUFFERED 1
ENV APP_HOME /app
WORKDIR $APP_HOME

# 1. Instalação de dependências do sistema necessárias para compilação/execução
# (Necessário para libs Python como cryptography e Pillow, e conectividade MySQL)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libssl-dev \
        libjpeg62-turbo-dev \
        default-libmysqlclient-dev \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 2. Instalação de dependências Python
COPY requirements.txt .
RUN pip install --upgrade pip
RUN pip install -r requirements.txt

# 3. Copia o código fonte do backend
COPY . $APP_HOME/

# Copia os arquivos estáticos do frontend do estágio de build
COPY --from=frontend-builder /app/frontend/build $APP_HOME/frontend/build

# 4. Cria o diretório de uploads (necessário pelo app.py)
RUN mkdir -p uploads

# 5. Configuração de Execução
EXPOSE 8000
# Comando de execução: Inicia o servidor uvicorn conforme definido em app.py
CMD ["python", "app.py"]
