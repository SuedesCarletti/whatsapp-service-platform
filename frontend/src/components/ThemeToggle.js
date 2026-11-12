/**
 * ThemeToggle Component
 * 
 * Toggle para alternar entre Dark Mode e Light Mode
 * Estilo igual ao WhatsApp Web
 */
import React from 'react';
import { MdDarkMode, MdLightMode } from 'react-icons/md';
import '../styles/ThemeToggle.css';

// Componente refatorado para ser puramente presentacional
const ThemeToggle = ({ currentTheme, toggleTheme }) => {

  return (
    <button 
      className="theme-toggle-button" 
      onClick={toggleTheme}
      title={currentTheme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'}
      aria-label={currentTheme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'}
    >
      {currentTheme === 'dark' ? (
        <MdLightMode size={20} />
      ) : (
        <MdDarkMode size={20} />
      )}
    </button>
  );
};

export default ThemeToggle;
