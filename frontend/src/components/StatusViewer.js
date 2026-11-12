import React, { useState, useEffect } from 'react';
import moment from 'moment';
import apiService from '../services/api';
import '../styles/StatusViewer.css';

const StatusViewer = ({ onClose, accountId }) => {
  const [statuses, setStatuses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState(null);

  useEffect(() => {
    const fetchStatuses = async () => {
      try {
        setLoading(true);
        // Backend já filtra pra status@broadcast e últimas 24h (GET /api/statuses)
        const allMessages = await apiService.getStatuses(accountId);

        // Group by participant_jid
        const grouped = {};
        allMessages.forEach(msg => {
          const participant = msg.participant_jid || msg.from_number;
          if (!participant) return;
          if (!grouped[participant]) {
            grouped[participant] = {
              participant,
              name: msg.sender_push_name || participant.split('@')[0],
              statuses: []
            };
          }
          grouped[participant].statuses.push(msg);
        });

        setStatuses(Object.values(grouped));
      } catch (error) {
        console.error('Error fetching statuses:', error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchStatuses();
  }, [accountId]);

  return (
    <div className="status-viewer-overlay">
      <div className="status-viewer-container">
        <div className="status-sidebar">
          <div className="status-header">
            <h2>Status</h2>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
          <div className="status-list">
            {loading ? (
              <div className="loading-text">Carregando...</div>
            ) : statuses.length === 0 ? (
              <div className="empty-text">Nenhum status recente.</div>
            ) : (
              statuses.map(user => (
                <div 
                  key={user.participant} 
                  className={`status-item ${selectedUser?.participant === user.participant ? 'active' : ''}`}
                  onClick={() => setSelectedUser(user)}
                >
                  <div className="status-avatar">{user.name.charAt(0).toUpperCase()}</div>
                  <div className="status-info">
                    <span className="status-name">{user.name}</span>
                    <span className="status-time">
                      {moment(user.statuses[user.statuses.length - 1].timestamp).format('HH:mm')}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="status-content">
          {selectedUser ? (
            <div className="status-carousel">
              <h3>{selectedUser.name}</h3>
              {/* Simplified display for the most recent status, or map through them */}
              <div className="status-media-container">
                {selectedUser.statuses.map((s, idx) => (
                  <div key={idx} className="status-media-item" style={{ marginBottom: '20px' }}>
                    {s.type === 'image' && s.mediaUrl ? (
                      <img src={s.mediaUrl} alt="Status" style={{ maxWidth: '100%', maxHeight: '400px' }} />
                    ) : s.type === 'video' && s.mediaUrl ? (
                      <video src={s.mediaUrl} controls style={{ maxWidth: '100%', maxHeight: '400px' }} />
                    ) : (
                      <div className="status-text-item">{s.message_text || s.message || '[Mídia não suportada]'}</div>
                    )}
                    {s.caption && <div className="status-caption">{s.caption}</div>}
                    <div className="status-timestamp">{moment(s.timestamp).format('DD/MM/YYYY HH:mm')}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="status-placeholder">
              <svg viewBox="0 0 24 24" width="80" height="80" fill="var(--icon-color)">
                <path d="M12 21.053a9.053 9.053 0 1 0 0-18.106 9.053 9.053 0 0 0 0 18.106zm0-1.953a7.1 7.1 0 1 1 0-14.2 7.1 7.1 0 0 1 0 14.2z"></path>
              </svg>
              <p>Clique em um contato para ver seu status</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StatusViewer;
