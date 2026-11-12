/**
 * Ponto de Entrada da Aplicação React
 * 
 * Este arquivo é responsável por:
 * 1. Renderizar o componente App no DOM
 * 2. Inicializar o React
 * 3. Importar estilos globais
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

/**
 * Renderiza a aplicação React
 * 
 * - Pega o elemento <div id="root"> do public/index.html
 * - Renderiza o componente <App /> dentro dele
 * - StrictMode ativa verificações e avisos adicionais no desenvolvimento
 */
const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

/**
 * IMPORTANTE:
 * 
 * Este arquivo NÃO pode ser removido ou ficar vazio!
 * Sem ele, o React não consegue inicializar e a aplicação não funciona.
 * 
 * Fluxo de carregamento:
 * 1. Browser carrega public/index.html
 * 2. HTML tem <div id="root"></div>
 * 3. HTML carrega este arquivo index.js
 * 4. Este arquivo renderiza <App /> dentro do root
 * 5. App.js renderiza toda a interface
 */

/**
 * Web Vitals (Opcional - para medir performance)
 * 
 * Se você quiser medir performance da aplicação, descomente:
 */

// import reportWebVitals from './reportWebVitals';
// reportWebVitals(console.log);
