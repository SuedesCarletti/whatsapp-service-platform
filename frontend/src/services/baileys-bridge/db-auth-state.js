/**
 * services/baileys-bridge/db-auth-state.js  (v3 — ESM)
 *
 * Auth state híbrido para Baileys:
 *   - Carrega credenciais do MySQL (Railway/produção)
 *   - Se não tiver MySQL configurado, usa arquivos locais
 *   - Sempre mantém cópia em arquivo local (fallback + compatibilidade)
 *
 * [FIX v3] SSL para TiDB Cloud (e qualquer banco cloud)
 *   Antes: ssl só ativado se dbUrl.includes('railway')
 *   Resultado: TiDB Cloud (tidbcloud.com / aws / prod) sem SSL → conexão recusada
 *   Agora: SSL ativado para qualquer host que NÃO seja localhost/127
 *   Adicionado: log de erro explícito no catch para visibilidade no Railway
 */

import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import path from 'path';
import fs   from 'fs';

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Retorna true se a URL aponta para um banco cloud (não-local).
 * TiDB Cloud, Railway Postgres, PlanetScale, AWS RDS, etc.
 * Critério simples: host não é localhost / 127.0.0.1.
 */
function isCloudDatabase(url) {
  if (!url) return false;
  try {
    // mysql://user:pass@hostname:port/db
    const match = url.match(/@([^:/]+)/);
    if (!match) return false;
    const host = match[1].toLowerCase();
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    return false;
  }
}

// ─── MySQL Pool ───────────────────────────────────────────────

export async function createMySQLPool() {
  const dbUrl = process.env.DATABASE_URL;

  try {
    const mysql = await import('mysql2/promise');

    if (dbUrl) {
      const needsSSL = isCloudDatabase(dbUrl);
      console.log(`[DBAuthState] DATABASE_URL detectada — SSL: ${needsSSL} (host cloud: ${needsSSL})`);

      const pool = mysql.createPool({
        uri:              dbUrl,
        ssl:              needsSSL ? { rejectUnauthorized: false } : undefined,
        connectionLimit:  3,
        waitForConnections: true,
        connectTimeout:   10000,
        charset:          'utf8mb4',
      });

      await pool.query('SELECT 1');
      console.log('[DBAuthState] MySQL conectado via DATABASE_URL ');
      return pool;
    }

    // Fallback: variáveis separadas DB_HOST / DB_USER / etc.
    const host = process.env.DB_HOST;
    const port = process.env.DB_PORT || '3306';
    const user = process.env.DB_USER;
    const pass = process.env.DB_PASSWORD;
    const name = process.env.DB_NAME;

    if (host && user && name) {
      const isCloud = host !== 'localhost' && host !== '127.0.0.1';
      console.log(`[DBAuthState] DB_* vars detectadas — host=${host} SSL: ${isCloud}`);

      const pool = mysql.createPool({
        host,
        port:             parseInt(port, 10),
        user,
        password:         pass,
        database:         name,
        ssl:              isCloud ? { rejectUnauthorized: false } : undefined,
        connectionLimit:  3,
        connectTimeout:   10000,
        charset:          'utf8mb4',
      });

      await pool.query('SELECT 1');
      console.log('[DBAuthState] MySQL conectado via DB_* vars ');
      return pool;
    }

    console.warn('[DBAuthState] Nenhuma variável de banco configurada — usando apenas arquivo');

  } catch (err) {
    // Log explícito do erro real para aparecer nos logs do Railway
    console.error(`[DBAuthState] Falha ao conectar MySQL: ${err.message}`);
    console.error(`[DBAuthState]    Code: ${err.code || 'n/a'} | SQL State: ${err.sqlState || 'n/a'}`);
    console.warn('[DBAuthState] Fallback: usando auth em arquivo (sessão será efêmera entre restarts)');
  }

  return null;
}

// ─── Tabela MySQL ─────────────────────────────────────────────

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bridge_sessions (
      session_id   VARCHAR(100) NOT NULL,
      provider     VARCHAR(20)  NOT NULL DEFAULT 'baileys',
      creds_json   LONGTEXT,
      keys_json    LONGTEXT,
      updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// ─── Reviver para restaurar Buffers do JSON ───────────────────

function bufferReviver(key, value) {
  if (
    value &&
    typeof value === 'object' &&
    value.type === 'Buffer' &&
    Array.isArray(value.data)
  ) {
    return Buffer.from(value.data);
  }
  return value;
}

async function loadFromDB(pool, sessionId) {
  try {
    const [rows] = await pool.query(
      'SELECT creds_json, keys_json FROM bridge_sessions WHERE session_id = ?',
      [sessionId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      creds: row.creds_json ? JSON.parse(row.creds_json, bufferReviver) : null,  // ← reviver
      keys:  row.keys_json  ? JSON.parse(row.keys_json,  bufferReviver) : {},    // ← reviver
    };
  } catch (err) {
    console.warn(`[DBAuthState] Erro ao carregar do MySQL: ${err.message}`);
    return null;
  }
}

async function saveToDB(pool, sessionId, creds, keys) {
  try {
    await pool.query(
      `INSERT INTO bridge_sessions (session_id, provider, creds_json, keys_json)
       VALUES (?, 'baileys', ?, ?)
       ON DUPLICATE KEY UPDATE
         creds_json = VALUES(creds_json),
         keys_json  = VALUES(keys_json),
         updated_at = CURRENT_TIMESTAMP`,
      [sessionId, JSON.stringify(creds), JSON.stringify(keys)],
    );
  } catch (err) {
    console.warn(`[DBAuthState] Erro ao salvar no MySQL: ${err.message}`);
  }
}

export async function deleteFromDB(pool, sessionId) {
  try {
    await pool.query('DELETE FROM bridge_sessions WHERE session_id = ?', [sessionId]);
  } catch (err) {
    console.warn(`[DBAuthState] Erro ao deletar do MySQL: ${err.message}`);
  }
}

// ─── Auth State Híbrido ───────────────────────────────────────

export async function useHybridAuthState(sessionId, pool, sessionsDir) {
  const authDir = path.join(sessionsDir, sessionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  if (pool) {
    try {
      await ensureTable(pool);
    } catch (err) {
      console.warn('[DBAuthState] Não foi possível criar tabela:', err.message);
    }
  }

  // Auth state base (arquivo)
  const { state: fileState, saveCreds: saveCredsToFile } = await useMultiFileAuthState(authDir);

  // Restaura do MySQL se disponível
  if (pool) {
    const dbData = await loadFromDB(pool, sessionId);
    if (dbData?.creds) {
      fileState.creds = { ...fileState.creds, ...dbData.creds };
      if (dbData.keys && Object.keys(dbData.keys).length > 0) {
        const keysFile = path.join(authDir, 'app-state-sync-key.json');
        if (!fs.existsSync(keysFile)) {
          fs.writeFileSync(keysFile, JSON.stringify(dbData.keys), 'utf8');
        }
      }
      console.log(`[DBAuthState] Estado restaurado do MySQL para sessão: ${sessionId} `);
    } else {
      console.log(`[DBAuthState] Nenhuma sessão salva no MySQL para: ${sessionId} (nova sessão)`);
    }
  }

  let keysSnapshot = {};

  const saveCreds = async () => {
    await saveCredsToFile();

    try {
      const keyFiles = fs.readdirSync(authDir).filter(f => f.endsWith('.json'));
      for (const file of keyFiles) {
        const content = fs.readFileSync(path.join(authDir, file), 'utf8');
        keysSnapshot[file] = JSON.parse(content);
      }
    } catch (_) {}

    if (pool) {
      await saveToDB(pool, sessionId, fileState.creds, keysSnapshot);
    }
  };

  const deleteSession = async () => {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    if (pool) {
      await deleteFromDB(pool, sessionId);
    }
  };

  return { state: fileState, saveCreds, deleteSession };
}
