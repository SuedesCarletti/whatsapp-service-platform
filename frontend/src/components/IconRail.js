/**
 * IconRail.js — Trilho vertical de ícones ao lado da Sidebar, estilo WhatsApp Web
 * (Status / Mídia / Perfil / Configurações / Admin).
 */
import React from 'react';
import { MdChat, MdDonutLarge, MdPhotoLibrary, MdChecklist, MdPerson, MdSettings, MdAdminPanelSettings } from 'react-icons/md';
import ThemeToggle from './ThemeToggle';
import '../styles/IconRail.css';

const getInitial = (name) => (name || '?').trim().charAt(0).toUpperCase();

const IconRail = ({
  isBaileys,
  isAdmin,
  onOpenStatus,
  onOpenMedia,
  onOpenTasks,
  myTasksUnreadCount = 0,
  onOpenProfile,
  onOpenSettings,
  onOpenAdmin,
  currentTheme,
  toggleTheme,
  myPhotoUrl,
  myFullName,
  onOpenMyAccount,
}) => {
  return (
    <div className="icon-rail">
      <div className="icon-rail-top">
        <img src="/assets/app-icon-white.png" alt="" className="icon-rail-logo" />
        <button className="icon-rail-btn active" title="Conversas" disabled>
          <MdChat size={22} />
        </button>
        <button className="icon-rail-btn" title="Status" onClick={onOpenStatus}>
          <MdDonutLarge size={22} />
        </button>
        <button className="icon-rail-btn" title="Mídia" onClick={onOpenMedia}>
          <MdPhotoLibrary size={22} />
        </button>
        <div className="icon-rail-btn-wrap">
          <button className="icon-rail-btn" title="Tarefas" onClick={onOpenTasks}>
            <MdChecklist size={22} />
          </button>
          {myTasksUnreadCount > 0 && (
            <span className="icon-rail-badge">{myTasksUnreadCount > 99 ? '99+' : myTasksUnreadCount}</span>
          )}
        </div>
        <ThemeToggle currentTheme={currentTheme} toggleTheme={toggleTheme} />
      </div>
      <div className="icon-rail-bottom">
        {isBaileys && (
          <button className="icon-rail-btn" title="Perfil da conta" onClick={onOpenProfile}>
            <MdPerson size={22} />
          </button>
        )}
        <button className="icon-rail-btn" title="Configurações" onClick={onOpenSettings}>
          <MdSettings size={22} />
        </button>
        {isAdmin && (
          <button className="icon-rail-btn" title="Painel administrativo" onClick={onOpenAdmin}>
            <MdAdminPanelSettings size={22} />
          </button>
        )}
        {/* Minha conta — foto/inicial, sempre por último. Some abaixo do
            Painel administrativo pra quem tem acesso; pra quem não tem,
            fica exatamente onde o botão do painel estaria (a condição acima
            já cuida disso sozinha, sem precisar de posição especial aqui). */}
        <button
          className="icon-rail-btn icon-rail-avatar-btn"
          title="Minha conta"
          onClick={onOpenMyAccount}
        >
          {myPhotoUrl
            ? <img src={myPhotoUrl} alt="" className="icon-rail-avatar-img" />
            : <span className="icon-rail-avatar-initial">{getInitial(myFullName)}</span>}
        </button>
      </div>
    </div>
  );
};

export default IconRail;
