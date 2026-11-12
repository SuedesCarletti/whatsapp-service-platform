-- ============================================
-- WHATSAPP CHAT DATABASE SCHEMA
-- ============================================

-- Create database if not exists
CREATE DATABASE IF NOT EXISTS whatsapp_chat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE whatsapp_chat;

-- ============================================
-- TABLE: contacts
-- Armazena informações dos contatos
-- ============================================
CREATE TABLE IF NOT EXISTS contacts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    wa_id VARCHAR(100) UNIQUE NOT NULL,
    phone_number VARCHAR(50) NOT NULL,
    lid VARCHAR(100) DEFAULT NULL COMMENT 'LID Baileys sem sufixo @lid (ex: 128904920580321)',
    name VARCHAR(255),
    push_name VARCHAR(255) DEFAULT NULL,
    profile_picture_url TEXT,
    is_group BOOLEAN NOT NULL DEFAULT FALSE,
    group_subject VARCHAR(255) DEFAULT NULL,
    is_internal BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Contato interno (colega/fornecedor) — sem bot/IA, sem SLA/CSAT/fora-do-horário',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_wa_id (wa_id),
    INDEX idx_phone (phone_number),
    INDEX idx_lid (lid),
    INDEX idx_is_group (is_group)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLE: conversations
-- Armazena as conversas
-- ============================================
CREATE TABLE IF NOT EXISTS conversations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contact_id INT NOT NULL,
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    unread_count INT DEFAULT 0,
    is_archived BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    INDEX idx_last_message (last_message_at),
    INDEX idx_contact (contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLE: messages
-- Armazena todas as mensagens
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    wamid VARCHAR(255) UNIQUE NOT NULL,
    conversation_id INT NOT NULL,
    contact_id INT NOT NULL,
    message_type ENUM('text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'interactive', 'template') NOT NULL,
    direction ENUM('inbound', 'outbound') NOT NULL,
    message_text TEXT,
    media_id VARCHAR(255),
    media_url TEXT,
    mime_type VARCHAR(100),
    caption TEXT,
    filename VARCHAR(255),
    status ENUM('sent', 'delivered', 'read', 'failed') DEFAULT 'sent',
    timestamp BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    INDEX idx_wamid (wamid),
    INDEX idx_conversation (conversation_id),
    INDEX idx_timestamp (timestamp),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLE: media_files
-- Armazena metadados dos arquivos de mídia
-- ============================================
CREATE TABLE IF NOT EXISTS media_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    media_id VARCHAR(255) UNIQUE NOT NULL,
    message_id INT,
    file_path TEXT,
    file_size BIGINT,
    mime_type VARCHAR(100),
    sha256_hash VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    INDEX idx_media_id (media_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLE: webhook_logs
-- Registra todos os webhooks recebidos
-- ============================================
CREATE TABLE IF NOT EXISTS webhook_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    webhook_type VARCHAR(50),
    payload JSON,
    processed BOOLEAN DEFAULT FALSE,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_processed (processed),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- TABLE: woocommerce_orders (para integração futura)
-- ============================================
CREATE TABLE IF NOT EXISTS woocommerce_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    contact_id INT,
    order_status VARCHAR(50),
    order_total DECIMAL(10, 2),
    customer_name VARCHAR(255),
    customer_email VARCHAR(255),
    customer_phone VARCHAR(20),
    whatsapp_notification_sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
    INDEX idx_order_id (order_id),
    INDEX idx_customer_phone (customer_phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- VIEWS para facilitar consultas
-- ============================================

-- View: Últimas mensagens por conversa
CREATE OR REPLACE VIEW latest_messages_view AS
SELECT 
    c.id as conversation_id,
    c.contact_id,
    co.name as contact_name,
    co.phone_number,
    m.message_text,
    m.message_type,
    m.direction,
    m.timestamp,
    m.status
FROM conversations c
JOIN contacts co ON c.contact_id = co.id
LEFT JOIN messages m ON m.conversation_id = c.id
WHERE m.id = (
    SELECT id FROM messages 
    WHERE conversation_id = c.id 
    ORDER BY timestamp DESC 
    LIMIT 1
);

-- View: Estatísticas de conversas
CREATE OR REPLACE VIEW conversation_stats AS
SELECT 
    c.id as conversation_id,
    co.name as contact_name,
    COUNT(m.id) as total_messages,
    SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END) as inbound_messages,
    SUM(CASE WHEN m.direction = 'outbound' THEN 1 ELSE 0 END) as outbound_messages,
    c.unread_count,
    c.last_message_at
FROM conversations c
JOIN contacts co ON c.contact_id = co.id
LEFT JOIN messages m ON m.conversation_id = c.id
GROUP BY c.id, co.name, c.unread_count, c.last_message_at;

-- ============================================
-- STORED PROCEDURES
-- ============================================

-- Procedure: Marcar mensagens como lidas
DELIMITER $$
CREATE PROCEDURE mark_messages_as_read(IN conv_id INT)
BEGIN
    UPDATE messages 
    SET status = 'read' 
    WHERE conversation_id = conv_id 
    AND direction = 'inbound' 
    AND status != 'read';
    
    UPDATE conversations 
    SET unread_count = 0 
    WHERE id = conv_id;
END$$
DELIMITER ;

-- ============================================
-- TRIGGERS
-- ============================================

-- Trigger: Atualizar contador de não lidas
DELIMITER $$
CREATE TRIGGER update_unread_count 
AFTER INSERT ON messages
FOR EACH ROW
BEGIN
    IF NEW.direction = 'inbound' AND NEW.status != 'read' THEN
        UPDATE conversations 
        SET unread_count = unread_count + 1,
            last_message_at = FROM_UNIXTIME(NEW.timestamp/1000)
        WHERE id = NEW.conversation_id;
    END IF;
END$$
DELIMITER ;

-- ============================================
-- INITIAL DATA (opcional)
-- ============================================

-- Inserir dados de teste (comentar em produção)
-- INSERT INTO contacts (wa_id, phone_number, name) VALUES
-- ('5511999990001', '5511999990001', 'Contato Teste 1'),
-- ('5511999990002', '5511999990002', 'Contato Teste 2');

SELECT 'Database schema created successfully!' as message;