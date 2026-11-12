module.exports = {
  apps: [{
    name: 'baileys-bridge',
    script: 'index.js',
    env: {
      PORT: '3001',
      FASTAPI_URL: 'http://localhost:8000',
      DATABASE_URL: process.env.DATABASE_URL,
      SESSIONS_DIR: '/home/whatsapp/app/frontend/src/services/baileys-bridge/sessions'
    }
  }]
}
