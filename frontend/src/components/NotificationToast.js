// LOCALIZAÇÃO: Criar novo arquivo
// Sistema de notificações para feedback em tempo real

import React, { useEffect } from 'react';
import { MdCheckCircle, MdError, MdInfo, MdWarning } from 'react-icons/md';
import '../styles/NotificationToast.css';

const NotificationToast = ({ type, message, onClose, duration = 5000 }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, duration);

    return () => clearTimeout(timer);
  }, [onClose, duration]);

  const icons = {
    success: <MdCheckCircle size={24} />,
    error: <MdError size={24} />,
    info: <MdInfo size={24} />,
    warning: <MdWarning size={24} />
  };

  return (
    <div className={`notification-toast notification-${type}`}>
      <div className="notification-icon">{icons[type]}</div>
      <div className="notification-message">{message}</div>
      <button className="notification-close" onClick={onClose}>×</button>
    </div>
  );
};

export default NotificationToast;
