// frontend/src/components/AdminPanel/AdminPanel.js
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './AdminPanel.css';
import AdminDashboardTab from './AdminDashboardTab';

// Permissões conhecidas do sistema, agrupadas por TELA para exibição na matriz
// de papéis — cada permissão aqui tem um enforcement real correspondente no
// backend (ver backend/api/permissions.py e os grep-outs de user_has_permission/
// require_permission nas rotas). Pra adicionar uma permissão nova: (1) declarar
// aqui com group = uma das telas abaixo, (2) checar com user_has_permission()
// ou require_permission() na rota certa, (3) dar um valor default sensato nos
// 3 papéis builtin (tabela `roles`) pra não quebrar quem já usa a função hoje.
const PERMISSION_GROUPS = [
  { key: 'WhatsApp',       icon: '💬', hint: 'Tela de Clientes — conversas com contatos via WhatsApp' },
  { key: 'Equipe',         icon: '👥', hint: 'Chat interno entre usuários do sistema' },
  { key: 'Configurações',  icon: '⚙️', hint: 'Cada aba de Configurações vira uma seção própria abaixo — abra pra ver/marcar as permissões daquela aba. Aba sem nenhuma permissão marcada some do menu do usuário.' },
  { key: 'Painel Admin',   icon: '🛠️', hint: 'Painel administrativo — quem é is_admin=True sempre enxerga tudo; estas permissões abrem só a(s) aba(s) marcada(s) do Painel Admin pra quem NÃO é is_admin.' },
];

// Só usado pra agrupar as permissões da tela "Configurações" por ABA (uma
// seção/dropdown por aba dentro do grupo, em vez de ~20 permissões soltas).
// Ordem aqui = ordem das abas em SettingsModal.js TABS.
const SETTINGS_TABS_META = {
  general:           { label: 'Geral',            icon: '⚙️' },
  accounts:          { label: 'Contas WA',        icon: '📱' },
  meta_app:          { label: 'App Meta',         icon: '🧩' },
  analytics:         { label: 'Analytics',        icon: '📊' },
  business_profile:  { label: 'Perfil Negócio',   icon: '🏢' },
  templates:         { label: 'Templates',        icon: '📄' },
  catalog:           { label: 'Catálogo',         icon: '🏬' },
  flows:             { label: 'Flows',            icon: '📋' },
  phone_quality:     { label: 'Qualidade do Número', icon: '📶' },
  users:             { label: 'Usuários',         icon: '👤' },
  atendimento:       { label: 'Atendimento',      icon: '🏷️' },
  internal_contacts: { label: 'Contatos internos', icon: '💼' },
  automations:       { label: 'Automações',       icon: '🤖' },
};

const PERMISSIONS_DEF = {
  // ───────────── WhatsApp (tela Clientes) ─────────────
  feature_view_all_accounts:  { label: 'Ver Todas as Contas WhatsApp',  group: 'WhatsApp' },
  feature_view_all_chats:     { label: 'Ver Todos os Chats (não só os meus, em qualquer conta)', group: 'WhatsApp' },
  // Pra atendentes que dividem um número com colega — só enxergam a
  // conversa um do outro nas contas que ELES MESMOS têm acesso (não dá
  // acesso a conta nova nenhuma, isso continua controlado por
  // "Ver Todas as Contas" + Contas WhatsApp que pode ver/usar em Usuários).
  // Decoupled de "Ver Todos os Chats" de propósito — dá pra desligar só
  // esta no futuro (ex: quando existir fila de atendimento de verdade) sem
  // mexer na permissão mais ampla, que serve outro propósito (supervisor).
  feature_view_shared_account_chats: { label: 'Ver Conversas de Colegas nas Mesmas Contas (só nas contas que eu também tenho acesso)', group: 'WhatsApp' },
  // Participa da mecânica de atendimento de verdade: entra no pool de
  // auto-atribuição ao responder, pode ser atribuído/transferido a uma
  // conversa, e conta tempo de SLA. Papel sem essa marcada ainda pode
  // enxergar/mandar mensagem (se as outras permissões permitirem), só não
  // "gruda" como responsável de conversa nem entra na fila/SLA — pensado
  // pra perfis como logística/vendas que respondem esporadicamente mas não
  // são atendentes de fila (existia só no backend até aqui, sem jeito de
  // ligar/desligar pela tela; ver feature_attendance_agent em
  // backend/api/permissions.py e routes_attendance.py::_is_attendance_agent).
  feature_attendance_agent:  { label: 'Participar do Atendimento (fila de auto-atribuição e contagem de SLA)', group: 'WhatsApp' },
  conversation_assign_others: { label: 'Atribuir Conversas a Outros Atendentes', group: 'WhatsApp' },
  profile_edit_sensitive:     { label: 'Editar Perfil da Conta WhatsApp (foto/nome/recado)', group: 'WhatsApp', sensitive: true },
  feature_send_templates:     { label: 'Enviar Templates',              group: 'WhatsApp' },
  feature_send_media:         { label: 'Enviar Mídia / Arquivos',       group: 'WhatsApp' },
  feature_send_interactive:   { label: 'Enviar Botões e Listas',        group: 'WhatsApp' },
  feature_send_products:      { label: 'Enviar Produtos / Catálogo',    group: 'WhatsApp' },
  feature_send_location:      { label: 'Enviar Localização',            group: 'WhatsApp' },
  feature_send_contacts:      { label: 'Enviar Contatos',               group: 'WhatsApp' },
  feature_qr_manager:         { label: 'Gerenciar QR Code / Pareamento de Sessão', group: 'WhatsApp' },
  feature_broadcast:          { label: 'Broadcast / Transmissão em Massa', group: 'WhatsApp' },
  feature_export_data:        { label: 'Exportar Dados de Conversas',   group: 'WhatsApp' },
  feature_group_manage:       { label: 'Gerenciar Grupos do WhatsApp (criar/participantes/admins/config)', group: 'WhatsApp' },
  feature_chat_actions:       { label: 'Ações Sensíveis de Chat (apagar conversa, bloquear contato, privacidade)', group: 'WhatsApp' },

  // ───────────── Equipe (chat interno) ─────────────
  feature_internal_create_group: { label: 'Criar Grupos no Chat de Equipe', group: 'Equipe' },

  // ───────────── Configurações ─────────────
  // Cada permissão carrega `tab` = a aba de SettingsModal.js que ela
  // controla (ver SETTINGS_TABS_META acima) — é o que permite agrupar por
  // aba na tela de edição de Papel. Aba "Minha Conta" (troca da própria
  // senha) não tem entrada aqui de propósito: é sempre visível pra
  // qualquer usuário logado, não dá pra restringir.
  settings_general:          { label: 'Acesso à aba (tema/idioma/sons)', group: 'Configurações', tab: 'general' },
  settings_accounts:         { label: 'Gerenciar Contas WhatsApp (criar/editar/remover)', group: 'Configurações', tab: 'accounts' },
  settings_credentials:      { label: 'Ver Credenciais/Tokens Reais (senão vêm mascarados)', group: 'Configurações', tab: 'accounts', sensitive: true },
  settings_meta_app:         { label: 'Acesso à aba (credenciais do App Meta p/ Embedded Signup)', group: 'Configurações', tab: 'meta_app' },
  settings_analytics:        { label: 'Visualizar Analytics',         group: 'Configurações', tab: 'analytics' },
  settings_business_profile: { label: 'Perfil do Negócio (Meta)',     group: 'Configurações', tab: 'business_profile' },
  settings_users:            { label: 'Gerenciar Usuários',           group: 'Configurações', tab: 'users' },
  feature_templates_manage:  { label: 'Gerenciar Templates (criar/sincronizar/excluir)', group: 'Configurações', tab: 'templates' },
  settings_catalog:          { label: 'Gerenciar Catálogo de Produtos', group: 'Configurações', tab: 'catalog' },
  settings_flows:            { label: 'Gerenciar Flows (chaves/criar/publicar/excluir)', group: 'Configurações', tab: 'flows' },
  settings_phone_quality:    { label: 'Ver Qualidade do Número',      group: 'Configurações', tab: 'phone_quality' },
  // Automações (aba "Automações") — 4 permissões distintas em vez de uma
  // "settings_automations" genérica, pra quem só deve mexer numa parte
  // (ex: só CSAT) não precisar da permissão pra tudo o resto.
  settings_auto_reply:       { label: 'Automações: Resposta Automática', group: 'Configurações', tab: 'automations' },
  settings_business_hours:   { label: 'Automações: Horário de Atendimento', group: 'Configurações', tab: 'automations' },
  settings_csat:             { label: 'Automações: Pesquisa de Satisfação (CSAT)', group: 'Configurações', tab: 'automations' },
  settings_sla:              { label: 'Automações: SLA (tempo de espera)', group: 'Configurações', tab: 'automations' },
  // Aba "Atendimento" (cores de status + etiquetas — diferente da tela
  // Atendimento em si, que é a fila de conversas, controlada por
  // feature_view_all_chats/conversation_assign_others lá em cima).
  settings_attendance_config: { label: 'Atendimento: Cores de Status e Etiquetas', group: 'Configurações', tab: 'atendimento' },
  // Aba "Contatos" (Contatos internos — marcar número como colega/fornecedor).
  settings_internal_contacts: { label: 'Contatos: Marcar/Desmarcar Contato Interno', group: 'Configurações', tab: 'internal_contacts' },

  // ───────────── Painel Admin ─────────────
  // is_admin=True sempre enxerga o Painel Admin inteiro (bypass em
  // require_admin_permission, backend/api/routes_admin.py). Estas
  // permissões só importam pra abrir UMA aba específica do painel pra
  // quem não é is_admin — granularidade nova, antes era tudo ou nada.
  admin_dashboard:     { label: 'Dashboard (estatísticas gerais)',        group: 'Painel Admin' },
  admin_accounts:      { label: 'Contas (visão geral de todas as contas)', group: 'Painel Admin' },
  admin_roles:         { label: 'Papéis (editar a matriz de permissões)', group: 'Painel Admin' },
  admin_approvals:     { label: 'Aprovações (revisar mudanças pendentes)', group: 'Painel Admin' },
  admin_system_config: { label: 'Configurações do Sistema (limites/providers/segurança)', group: 'Painel Admin' },
};

// Aba do Painel Admin -> permissão(ões) que abrem ela pra quem NÃO é
// is_admin (quem é is_admin=True sempre vê tudo — bypass no backend em
// require_admin_permission, backend/api/routes_admin.py). "config" reaproveita
// settings_meta_app porque as duas abas (App Meta em Configurações e
// Configurações do Sistema aqui) batem no mesmo endpoint /api/admin/config.
const ADMIN_TAB_PERMS = {
  dashboard: ['admin_dashboard'],
  users:     ['settings_users'],
  accounts:  ['admin_accounts'],
  roles:     ['admin_roles'],
  approvals: ['admin_approvals'],
  config:    ['settings_meta_app', 'admin_system_config'],
};

// O `detail` de um 422 de validação do FastAPI é uma LISTA de objetos
// ({loc, msg, type, ...}), não uma string — `'Erro: ' + error.response.data.detail`
// concatenava essa lista e virava literalmente "[object Object]" na tela
// (Array.toString() chama toString() de cada item, que é um objeto puro).
const getApiErrorMessage = (error, fallback = 'Erro desconhecido') => {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map(d => d?.msg || JSON.stringify(d)).join('; ');
  if (detail) return JSON.stringify(detail);
  return error?.message || fallback;
};

const AdminPanel = ({ onClose, isAdmin = false, permissions = {} }) => {
  const canSeeAdminTab = (tabId) => isAdmin
    || (ADMIN_TAB_PERMS[tabId] || []).some(k => permissions?.[k] === true || permissions?.[k] === 'require_approval');
  const visibleAdminTabs = Object.keys(ADMIN_TAB_PERMS).filter(canSeeAdminTab);

  const [activeTab, setActiveTab] = useState(() => visibleAdminTabs[0] || 'dashboard');
  const [users, setUsers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [config, setConfig] = useState(null);
  const [roles, setRoles] = useState([]);
  const [pendingChanges, setPendingChanges] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  // Ids de conta com exclusão em andamento — desabilita o botão até a
  // requisição voltar, pra clique repetido não virar tentativa duplicada.
  const [deletingAccountIds, setDeletingAccountIds] = useState(() => new Set());

  // Modal states
  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editingAccount, setEditingAccount] = useState(null);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState(null);

  const API = axios.create({
    baseURL: '/api/admin',
    headers: {
      'Authorization': `Bearer ${localStorage.getItem('token')}`
    }
  });

  useEffect(() => {
    loadData();
  }, [activeTab]);

  // Contador de pendências no ícone da aba — atualiza independente de qual aba
  // está ativa, pra sempre mostrar o badge quando existir algo aguardando.
  const loadPendingCount = async () => {
    try {
      const res = await API.get('/pending-changes', { params: { status_filter: 'pending' } });
      setPendingCount(res.data.length);
    } catch { /* silent — usuário pode não ser admin */ }
  };

  useEffect(() => {
    loadPendingCount();
    const interval = setInterval(loadPendingCount, 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      switch (activeTab) {
        case 'dashboard':
          // AdminDashboardTab busca os próprios dados (stats+trends, com
          // filtro de período/conta) — nada a carregar aqui.
          break;
        case 'users':
          // Papel (role) e contas concedidas de cada usuário são escolhidos
          // no formulário a partir das listas reais — precisam estar
          // carregadas mesmo se o admin nunca visitou "Papéis"/"Contas" nesta sessão.
          // /roles e /accounts toleram 403 (fica lista vazia): quem tem só
          // settings_users (sem admin_roles/admin_accounts) ainda precisa
          // conseguir usar a aba Usuários, só sem essas duas listas de apoio.
          const usersRes = await API.get('/users');
          const [usersRolesRes, usersAccountsRes] = await Promise.all([
            API.get('/roles').catch(() => ({ data: [] })),
            API.get('/accounts').catch(() => ({ data: [] })),
          ]);
          setUsers(usersRes.data);
          setRoles(usersRolesRes.data);
          setAccounts(usersAccountsRes.data);
          break;
        case 'accounts':
          const accountsRes = await API.get('/accounts');
          setAccounts(accountsRes.data);
          break;
        case 'config':
          const configRes = await API.get('/config');
          setConfig(configRes.data);
          break;
        case 'roles':
          const rolesRes = await API.get('/roles');
          setRoles(rolesRes.data);
          break;
        case 'approvals':
          const pendingRes = await API.get('/pending-changes', { params: { status_filter: 'pending' } });
          setPendingChanges(pendingRes.data);
          setPendingCount(pendingRes.data.length);
          break;
      }
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
      alert('Erro ao carregar dados. Verifique se você é administrador.');
    } finally {
      setLoading(false);
    }
  };

  // USERS MANAGEMENT

  const renderUsers = () => (
    <div className="admin-users">
      <div className="section-header">
        <h2>👥 Gerenciar Usuários</h2>
        <button 
          className="btn-primary"
          onClick={() => {
            setEditingUser({
              email: '',
              password: '',
              full_name: '',
              is_admin: false,
              role: 'attendant',
              sector: '',
              account_ids: [],
            });
            setShowUserModal(true);
          }}
        >
          + Novo Usuário
        </button>
      </div>

      <div className="users-table">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Email</th>
              <th>Nome</th>
              <th>Status</th>
              <th>Papel</th>
              <th>Admin</th>
              <th>Contas</th>
              <th>Mensagens</th>
              <th>Criado em</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr key={user.id}>
                <td>{user.id}</td>
                <td>{user.email}</td>
                <td>{user.full_name || '-'}</td>
                <td>
                  <span className={`status-badge ${user.is_active ? 'active' : 'inactive'}`}>
                    {user.is_active ? 'Ativo' : 'Inativo'}
                  </span>
                </td>
                <td>
                  {(() => {
                    const r = roles.find(r => r.key === user.role);
                    return r
                      ? <span style={{ background: r.color, color: '#fff', padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600 }}>{r.label}</span>
                      : <span style={{ color: 'var(--text-secondary, #888)', fontSize: 12 }}>{user.role || '—'}</span>;
                  })()}
                </td>
                <td>
                  {user.is_admin && <span className="admin-badge">✓ Admin</span>}
                </td>
                <td>{user.total_accounts}</td>
                <td>{user.total_messages_sent}</td>
                <td>{new Date(user.created_at).toLocaleDateString('pt-BR')}</td>
                <td>
                  <div className="action-buttons">
                    <button 
                      className="btn-edit"
                      onClick={() => handleEditUser(user)}
                    >
                      ✏️
                    </button>
                    <button 
                      className="btn-delete"
                      onClick={() => handleDeleteUser(user.id)}
                    >
                      🗑️
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal de Edição */}
      {showUserModal && (
        <UserModal
          user={editingUser}
          roles={roles}
          accounts={accounts}
          onClose={() => {
            setShowUserModal(false);
            setEditingUser(null);
          }}
          onSave={handleSaveUser}
        />
      )}
    </div>
  );

  const handleEditUser = (user) => {
    setEditingUser({
      id: user.id,
      email: user.email,
      full_name: user.full_name || '',
      is_active: user.is_active,
      is_admin: user.is_admin,
      role: user.role || 'attendant',
      sector: user.sector || '',
      account_ids: user.account_ids || [],
      password: '' // Vazio, só muda se preencher
    });
    setShowUserModal(true);
  };

  const handleSaveUser = async (userData) => {
    try {
      if (userData.id) {
        // Atualizar
        await API.patch(`/users/${userData.id}`, userData);
        alert('Usuário atualizado com sucesso!');
      } else {
        // Criar
        await API.post('/users', userData);
        alert('Usuário criado com sucesso!');
      }
      
      setShowUserModal(false);
      setEditingUser(null);
      loadData();
    } catch (error) {
      console.error('Erro ao salvar usuário:', error);
      alert('Erro ao salvar usuário: ' + getApiErrorMessage(error));
    }
  };

  const handleDeleteUser = async (userId) => {
    if (!window.confirm('Tem certeza que deseja deletar este usuário? Esta ação não pode ser desfeita.')) {
      return;
    }

    try {
      await API.delete(`/users/${userId}`);
      alert('Usuário deletado com sucesso!');
      loadData();
    } catch (error) {
      console.error('Erro ao deletar usuário:', error);
      alert('Erro ao deletar usuário');
    }
  };

  // ACCOUNTS MANAGEMENT

  const renderAccounts = () => (
    <div className="admin-accounts">
      <h2>📱 Gerenciar Contas WhatsApp</h2>

      <div className="accounts-table">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Usuário</th>
              <th>Nome da Conta</th>
              <th>Número</th>
              <th>Provider</th>
              {/* Coluna Tier escondida — ver comentário na seção "Distribuição por Tier" acima */}
              <th>Status</th>
              <th>Mensagens</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map(account => (
              <tr key={account.id}>
                <td>{account.id}</td>
                <td>{account.user_email}</td>
                <td>{account.account_name}</td>
                <td>{account.phone_number}</td>
                <td>
                  <span className="provider-badge" data-provider={account.provider_type}>
                    {getProviderDisplayName(account.provider_type)}
                  </span>
                </td>
                {/* Célula Tier escondida — mesmo motivo do cabeçalho acima
                <td>
                  <span className="tier-badge" data-tier={account.provider_tier}>
                    {getTierDisplayName(account.provider_tier)}
                  </span>
                </td>
                */}
                <td>
                  <span className={`status-badge ${account.is_authenticated ? 'active' : 'inactive'}`}>
                    {account.is_authenticated ? '✓ Autenticado' : '⚠️ Pendente'}
                  </span>
                </td>
                <td>{account.total_messages}</td>
                <td>
                  <div className="action-buttons">
                    <button 
                      className="btn-edit"
                      onClick={() => handleEditAccount(account)}
                    >
                      ✏️
                    </button>
                    <button
                      className="btn-delete"
                      disabled={deletingAccountIds.has(account.id)}
                      style={deletingAccountIds.has(account.id) ? { opacity: 0.55, cursor: 'wait' } : undefined}
                      onClick={() => handleDeleteAccount(account.id)}
                    >
                      {deletingAccountIds.has(account.id) ? '⏳' : '🗑️'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const handleEditAccount = (account) => {
    setEditingAccount(account);
    // Abrir modal de edição
  };

  const handleDeleteAccount = async (accountId) => {
    if (deletingAccountIds.has(accountId)) return;
    if (!window.confirm(
      'Excluir esta conta WhatsApp? Isso desloga a sessão e revoga o acesso — ' +
      'ninguém mais poderá usá-la pra enviar/receber. As mensagens e conversas ' +
      'já existentes NÃO são apagadas, continuam no histórico.'
    )) {
      return;
    }

    setDeletingAccountIds(prev => new Set(prev).add(accountId));
    try {
      await API.delete(`/accounts/${accountId}`);
      alert('Acesso à conta revogado — histórico de mensagens preservado.');
      loadData();
    } catch (error) {
      console.error('Erro ao excluir conta:', error);
      alert(getApiErrorMessage(error, 'Erro ao excluir conta'));
    } finally {
      setDeletingAccountIds(prev => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  };

  // SYSTEM CONFIGURATION

  const renderConfig = () => (
    <div className="admin-config">
      <h2>⚙️ Configurações do Sistema</h2>

      {config && (
        <div className="config-form">
          <div className="config-section">
            <h3>Limites Padrão</h3>
            
            <div className="form-group">
              <label>Limite Diário de Mensagens</label>
              <input
                type="number"
                value={config.default_daily_limit}
                onChange={(e) => setConfig({
                  ...config,
                  default_daily_limit: parseInt(e.target.value)
                })}
              />
            </div>

            <div className="form-group">
              <label>Limite Mensal de Mensagens</label>
              <input
                type="number"
                value={config.default_monthly_limit}
                onChange={(e) => setConfig({
                  ...config,
                  default_monthly_limit: parseInt(e.target.value)
                })}
              />
            </div>

            <div className="form-group">
              <label>Máximo de Contas por Usuário</label>
              <input
                type="number"
                value={config.max_accounts_per_user}
                onChange={(e) => setConfig({
                  ...config,
                  max_accounts_per_user: parseInt(e.target.value)
                })}
              />
            </div>
          </div>

          <div className="config-section">
            <h3>Providers Habilitados</h3>

            <div className="form-group checkbox">
              <input
                type="checkbox"
                id="allow_unofficial"
                checked={config.allow_unofficial_providers}
                onChange={(e) => setConfig({
                  ...config,
                  allow_unofficial_providers: e.target.checked
                })}
              />
              <label htmlFor="allow_unofficial">
                Permitir providers não-oficiais (Baileys, Venom, etc)
              </label>
            </div>

            <div className="form-group checkbox">
              <input
                type="checkbox"
                id="enable_coex"
                checked={config.enable_coexistence}
                onChange={(e) => setConfig({
                  ...config,
                  enable_coexistence: e.target.checked
                })}
              />
              <label htmlFor="enable_coex">
                Habilitar Meta Coexistence
              </label>
            </div>

            <div className="form-group checkbox">
              <input
                type="checkbox"
                id="enable_mmlite"
                checked={config.enable_mmlite}
                onChange={(e) => setConfig({
                  ...config,
                  enable_mmlite: e.target.checked
                })}
              />
              <label htmlFor="enable_mmlite">
                Habilitar Meta MM Lite
              </label>
            </div>
          </div>

          <div className="config-section">
            <h3>Segurança</h3>

            <div className="form-group checkbox">
              <input
                type="checkbox"
                id="require_email_verification"
                checked={config.require_email_verification}
                onChange={(e) => setConfig({
                  ...config,
                  require_email_verification: e.target.checked
                })}
              />
              <label htmlFor="require_email_verification">
                Exigir verificação de email
              </label>
            </div>
          </div>

          <button
            className="btn-primary btn-large"
            onClick={handleSaveConfig}
          >
            💾 Salvar Configurações
          </button>
        </div>
      )}
    </div>
  );

  const handleSaveConfig = async () => {
    try {
      await API.patch('/config', config);
      alert('Configurações salvas com sucesso!');
    } catch (error) {
      console.error('Erro ao salvar configurações:', error);
      alert('Erro ao salvar configurações');
    }
  };

  // ROLES / PERMISSIONS MANAGEMENT

  const renderRoles = () => (
    <div className="admin-roles">
      <div className="section-header">
        <h2>🔑 Papéis e Permissões</h2>
        <button
          className="btn-primary"
          onClick={() => {
            setEditingRole({ key: '', label: '', color: '#0EA5A4', permissions: {} });
            setShowRoleModal(true);
          }}
        >
          + Novo Papel
        </button>
      </div>

      <div className="roles-table">
        <table>
          <thead>
            <tr>
              <th>Papel</th>
              <th>Chave</th>
              <th>Tipo</th>
              <th>Permissões ativas</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {roles.map(role => (
              <tr key={role.id}>
                <td>
                  <span className="role-color-dot" style={{ backgroundColor: role.color }} />
                  {role.label}
                </td>
                <td><code>{role.key}</code></td>
                <td>{role.is_builtin ? 'Padrão' : 'Customizado'}</td>
                <td>{Object.values(role.permissions || {}).filter(Boolean).length} / {Object.keys(PERMISSIONS_DEF).length}</td>
                <td>
                  <div className="action-buttons">
                    <button className="btn-edit" onClick={() => handleEditRole(role)}>✏️</button>
                    {!role.is_builtin && (
                      <button className="btn-delete" onClick={() => handleDeleteRole(role)}>🗑️</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showRoleModal && (
        <RoleModal
          role={editingRole}
          onClose={() => { setShowRoleModal(false); setEditingRole(null); }}
          onSave={handleSaveRole}
        />
      )}
    </div>
  );

  const handleEditRole = (role) => {
    setEditingRole({ ...role, permissions: { ...role.permissions } });
    setShowRoleModal(true);
  };

  const handleSaveRole = async (roleData) => {
    try {
      if (roleData.id) {
        await API.patch(`/roles/${roleData.id}`, {
          label: roleData.label,
          color: roleData.color,
          permissions: roleData.permissions,
        });
      } else {
        await API.post('/roles', {
          key: roleData.key,
          label: roleData.label,
          color: roleData.color,
          permissions: roleData.permissions,
        });
      }
      setShowRoleModal(false);
      setEditingRole(null);
      loadData();
    } catch (error) {
      console.error('Erro ao salvar papel:', error);
      alert('Erro ao salvar papel: ' + getApiErrorMessage(error));
    }
  };

  const handleDeleteRole = async (role) => {
    if (!window.confirm(`Apagar o papel "${role.label}"?`)) return;
    try {
      await API.delete(`/roles/${role.id}`);
      loadData();
    } catch (error) {
      alert('Erro ao apagar papel: ' + getApiErrorMessage(error));
    }
  };

  // APPROVALS (PendingChange)

  const CHANGE_TYPE_LABELS = {
    profile_picture_update: '🖼️ Atualizar foto de perfil',
    profile_picture_remove: '🗑️ Remover foto de perfil',
    profile_status: '💬 Atualizar recado/status',
    profile_name: '✏️ Atualizar nome de exibição',
  };

  const describeChange = (pc) => {
    if (pc.change_type === 'profile_name') return `Novo nome: "${pc.payload?.name}"`;
    if (pc.change_type === 'profile_status') return `Novo recado: "${pc.payload?.status}"`;
    if (pc.change_type === 'profile_picture_update') return 'Nova imagem enviada (base64)';
    return '';
  };

  const renderApprovals = () => (
    <div className="admin-approvals">
      <div className="section-header">
        <h2>Aprovações Pendentes</h2>
      </div>

      {pendingChanges.length === 0 ? (
        <p className="sm-loading">Nenhuma solicitação pendente no momento.</p>
      ) : (
        <div className="approvals-list">
          {pendingChanges.map(pc => (
            <div key={pc.id} className="approval-card">
              <div className="approval-info">
                <div className="approval-title">{CHANGE_TYPE_LABELS[pc.change_type] || pc.change_type}</div>
                <div className="approval-detail">{describeChange(pc)}</div>
                <div className="approval-meta">
                  Solicitado por <strong>{pc.requested_by_email}</strong> em {new Date(pc.created_at).toLocaleString('pt-BR')}
                </div>
              </div>
              <div className="approval-actions">
                <button className="btn-primary" onClick={() => handleApproveChange(pc.id)}>Aprovar</button>
                <button className="btn-delete" onClick={() => handleRejectChange(pc.id)}>❌ Rejeitar</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const handleApproveChange = async (id) => {
    try {
      await API.post(`/pending-changes/${id}/approve`);
      loadData();
    } catch (error) {
      alert('Erro ao aprovar: ' + getApiErrorMessage(error));
    }
  };

  const handleRejectChange = async (id) => {
    if (!window.confirm('Rejeitar esta solicitação?')) return;
    try {
      await API.post(`/pending-changes/${id}/reject`, {});
      loadData();
    } catch (error) {
      alert('Erro ao rejeitar: ' + getApiErrorMessage(error));
    }
  };

  // HELPER FUNCTIONS

  const getProviderDisplayName = (provider) => {
    const names = {
      'meta_cloud_basic': 'Meta Cloud',
      'meta_cloud_coexistence': 'Meta Coexistence',
      'meta_cloud_mmlite': 'Meta MM Lite',
      'meta_cloud_full': 'Meta Full Stack',
      'baileys': 'Baileys',
      'venom': 'Venom',
      'whatsapp_web_js': 'WhatsApp-Web.js',
      'wppconnect': 'WPPConnect'
    };
    return names[provider] || provider;
  };

  // Sem uso enquanto as seções de Tier acima estiverem comentadas (app de uso
  // interno, sem noção de plano pago) — descomenta junto com elas se precisar.
  // const getTierDisplayName = (tier) => {
  //   const names = {
  //     'free': 'Free',
  //     'starter': 'Starter',
  //     'business': 'Business',
  //     'professional': 'Professional',
  //     'enterprise': 'Enterprise'
  //   };
  //   return names[tier] || tier;
  // };

  // MAIN RENDER

  return (
    <div className="admin-panel">
      <div className="admin-sidebar">
        <div className="admin-sidebar-header">
          <h1>🔧 Admin</h1>
          {onClose && (
            <button className="admin-back-btn" onClick={onClose} title="Voltar para as conversas">
              ← Voltar
            </button>
          )}
        </div>

        <nav className="admin-nav">
          {canSeeAdminTab('dashboard') && (
            <button
              className={activeTab === 'dashboard' ? 'active' : ''}
              onClick={() => setActiveTab('dashboard')}
            >
              📊 Dashboard
            </button>
          )}
          {canSeeAdminTab('users') && (
            <button
              className={activeTab === 'users' ? 'active' : ''}
              onClick={() => setActiveTab('users')}
            >
              👥 Usuários
            </button>
          )}
          {canSeeAdminTab('accounts') && (
            <button
              className={activeTab === 'accounts' ? 'active' : ''}
              onClick={() => setActiveTab('accounts')}
            >
              📱 Contas
            </button>
          )}
          {canSeeAdminTab('roles') && (
            <button
              className={activeTab === 'roles' ? 'active' : ''}
              onClick={() => setActiveTab('roles')}
            >
              🔑 Papéis
            </button>
          )}
          {canSeeAdminTab('approvals') && (
            <button
              className={activeTab === 'approvals' ? 'active' : ''}
              onClick={() => setActiveTab('approvals')}
            >
              Aprovações
              {pendingCount > 0 && <span className="admin-nav-badge">{pendingCount}</span>}
            </button>
          )}
          {canSeeAdminTab('config') && (
            <button
              className={activeTab === 'config' ? 'active' : ''}
              onClick={() => setActiveTab('config')}
            >
              ⚙️ Configurações
            </button>
          )}
        </nav>
      </div>

      <div className="admin-content">
        {loading ? (
          <div className="loading">
            <div className="spinner"></div>
            <p>Carregando...</p>
          </div>
        ) : (
          <>
            {activeTab === 'dashboard' && canSeeAdminTab('dashboard') && <AdminDashboardTab API={API} />}
            {activeTab === 'users' && canSeeAdminTab('users') && renderUsers()}
            {activeTab === 'accounts' && canSeeAdminTab('accounts') && renderAccounts()}
            {activeTab === 'roles' && canSeeAdminTab('roles') && renderRoles()}
            {activeTab === 'approvals' && canSeeAdminTab('approvals') && renderApprovals()}
            {activeTab === 'config' && canSeeAdminTab('config') && renderConfig()}
          </>
        )}
      </div>
    </div>
  );
};

// USER MODAL COMPONENT

const UserModal = ({ user, roles, accounts, onClose, onSave }) => {
  const [formData, setFormData] = useState(user);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(formData);
  };

  const selectedRole = roles.find(r => r.key === (formData.role || 'attendant'));
  const roleSeesAllAccounts = formData.is_admin || (selectedRole && selectedRole.permissions?.feature_view_all_accounts);

  const toggleAccount = (accountId) => {
    const current = formData.account_ids || [];
    const next = current.includes(accountId)
      ? current.filter(id => id !== accountId)
      : [...current, accountId];
    setFormData({ ...formData, account_ids: next });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{user.id ? 'Editar Usuário' : 'Novo Usuário'}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email *</label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({...formData, email: e.target.value})}
              required
            />
          </div>

          <div className="form-group">
            <label>Nome Completo</label>
            <input
              type="text"
              value={formData.full_name}
              onChange={(e) => setFormData({...formData, full_name: e.target.value})}
            />
          </div>

          <div className="form-group">
            <label>Senha {user.id && '(deixe vazio para não alterar)'}</label>
            <input
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({...formData, password: e.target.value})}
              required={!user.id}
              placeholder={user.id ? '••••••••' : ''}
            />
          </div>

          <div className="form-group">
            <label>Papel</label>
            <select
              value={formData.role || 'attendant'}
              onChange={(e) => setFormData({...formData, role: e.target.value})}
            >
              {roles.length === 0 && <option value={formData.role || 'attendant'}>{formData.role || 'attendant'}</option>}
              {roles.map(r => (
                <option key={r.key} value={r.key}>{r.label}</option>
              ))}
            </select>
            <small>Define as permissões reais do usuário (gerenciadas na aba "Papéis") — diferente do checkbox "Administrador" abaixo, que sempre libera tudo independente do papel.</small>
          </div>

          <div className="form-group">
            <label>Setor</label>
            <input
              type="text"
              placeholder="ex: Vendas, Suporte, Financeiro"
              value={formData.sector || ''}
              onChange={(e) => setFormData({...formData, sector: e.target.value})}
            />
          </div>

          <div className="form-group">
            <label>Contas WhatsApp que pode ver/usar</label>
            {roleSeesAllAccounts ? (
              <small>Este papel já vê todas as contas automaticamente (permissão "Ver Todas as Contas WhatsApp") — não precisa marcar nenhuma aqui.</small>
            ) : accounts.length === 0 ? (
              <small style={{ color: 'var(--text-secondary, #888)' }}>Nenhuma conta cadastrada ainda.</small>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 6, padding: 8 }}>
                {accounts.map(acc => (
                  <label key={acc.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={(formData.account_ids || []).includes(acc.id)}
                      onChange={() => toggleAccount(acc.id)}
                    />
                    {acc.account_name} <small style={{ color: 'var(--text-secondary, #888)' }}>({acc.phone_number})</small>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="form-group checkbox">
            <input
              type="checkbox"
              id="is_active"
              checked={formData.is_active}
              onChange={(e) => setFormData({...formData, is_active: e.target.checked})}
            />
            <label htmlFor="is_active">Usuário ativo</label>
          </div>

          <div className="form-group checkbox">
            <input
              type="checkbox"
              id="is_admin"
              checked={formData.is_admin}
              onChange={(e) => setFormData({...formData, is_admin: e.target.checked})}
            />
            <label htmlFor="is_admin">Administrador</label>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary">
              💾 Salvar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ROLE MODAL COMPONENT

const RoleModal = ({ role, onClose, onSave }) => {
  const [formData, setFormData] = useState(role);
  const isNew = !role.id;

  const permsByGroup = Object.entries(PERMISSIONS_DEF).reduce((acc, [key, def]) => {
    (acc[def.group] = acc[def.group] || []).push({ key, ...def });
    return acc;
  }, {});
  // Ordem fixa por tela (PERMISSION_GROUPS) em vez da ordem de inserção do
  // objeto, pra "WhatsApp / Equipe / Configurações" sempre aparecer nessa
  // sequência mesmo que novas chaves sejam adicionadas fora de ordem.
  const groupSections = PERMISSION_GROUPS
    .map(g => ({ ...g, perms: permsByGroup[g.key] || [] }))
    .filter(g => g.perms.length > 0);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(formData);
  };

  const togglePermission = (key) => {
    setFormData(prev => ({
      ...prev,
      permissions: { ...prev.permissions, [key]: !prev.permissions?.[key] },
    }));
  };

  // Permissões "sensitive" (ex: profile_edit_sensitive) aceitam um 3º estado —
  // "require_approval" — em vez de só sim/não. Ver backend/api/permissions.py.
  const setPermissionValue = (key, value) => {
    setFormData(prev => ({
      ...prev,
      permissions: { ...prev.permissions, [key]: value === 'true' ? true : value === 'false' ? false : value },
    }));
  };

  const sensitiveValue = (key) => {
    const v = formData.permissions?.[key];
    if (v === true) return 'true';
    if (v === 'require_approval') return 'require_approval';
    return 'false';
  };

  const renderPermRow = (p) => p.sensitive ? (
    <div key={p.key} className="form-group sensitive-permission">
      <label htmlFor={`perm-${p.key}`}>{p.label}</label>
      <select
        id={`perm-${p.key}`}
        value={sensitiveValue(p.key)}
        onChange={(e) => setPermissionValue(p.key, e.target.value)}
      >
        <option value="true">Permitir</option>
        <option value="require_approval">⏳ Requer aprovação de admin</option>
        <option value="false">🚫 Negar</option>
      </select>
    </div>
  ) : (
    <div key={p.key} className="form-group checkbox">
      <input
        type="checkbox"
        id={`perm-${p.key}`}
        checked={!!formData.permissions?.[p.key]}
        onChange={() => togglePermission(p.key)}
      />
      <label htmlFor={`perm-${p.key}`}>{p.label}</label>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{isNew ? 'Novo Papel' : `Editar Papel — ${role.label}`}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Nome do papel *</label>
            <input
              type="text"
              value={formData.label}
              onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              placeholder="Ex: Financeiro"
              required
            />
          </div>

          {isNew && (
            <div className="form-group">
              <label>Chave (identificador único, sem espaços) *</label>
              <input
                type="text"
                value={formData.key}
                onChange={(e) => setFormData({ ...formData, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                placeholder="Ex: financeiro"
                required
              />
            </div>
          )}

          <div className="form-group">
            <label>Cor</label>
            <input
              type="color"
              value={formData.color}
              onChange={(e) => setFormData({ ...formData, color: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>Permissões por tela</label>
            {groupSections.map(({ key: groupName, icon, hint, perms }) => {
              const onCount = perms.filter(p => !!formData.permissions?.[p.key] || formData.permissions?.[p.key] === 'require_approval').length;
              const allOn = onCount === perms.length;
              const setAll = (value, subset = perms) => setFormData(prev => ({
                ...prev,
                permissions: { ...prev.permissions, ...Object.fromEntries(subset.map(p => [p.key, value])) },
              }));

              // Grupo "Configurações" ganha mais um nível: uma seção
              // (dropdown nativo <details>, fechada por padrão) por ABA de
              // SettingsModal.js, em vez de ~20 permissões soltas numa lista
              // só — cada aba sem nenhuma permissão marcada some do menu do
              // usuário (ver filtro de TABS em SettingsModal.js).
              const byTab = groupName === 'Configurações'
                ? perms.reduce((acc, p) => { (acc[p.tab] = acc[p.tab] || []).push(p); return acc; }, {})
                : null;

              return (
              <div key={groupName} className="permission-group">
                <div className="permission-group-title">
                  <span className="permission-group-title-main">{icon} {groupName}</span>
                  <span className="permission-group-count">{onCount}/{perms.length}</span>
                  <button type="button" className="permission-group-toggle-all" onClick={() => setAll(!allOn)}>
                    {allOn ? 'Limpar todas' : 'Marcar todas'}
                  </button>
                </div>
                {hint && <div className="permission-group-hint">{hint}</div>}

                {byTab ? Object.keys(SETTINGS_TABS_META).filter(tabId => byTab[tabId]?.length).map(tabId => {
                  const tabPerms = byTab[tabId];
                  const tabMeta = SETTINGS_TABS_META[tabId];
                  const tabOnCount = tabPerms.filter(p => !!formData.permissions?.[p.key] || formData.permissions?.[p.key] === 'require_approval').length;
                  const tabAllOn = tabOnCount === tabPerms.length;
                  return (
                    <details key={tabId} className="permission-tab-group">
                      <summary className="permission-tab-summary">
                        <span>{tabMeta.icon} {tabMeta.label}</span>
                        <span className="permission-group-count">{tabOnCount}/{tabPerms.length}</span>
                      </summary>
                      <div className="permission-tab-body">
                        <button type="button" className="permission-group-toggle-all" onClick={() => setAll(!tabAllOn, tabPerms)}>
                          {tabAllOn ? 'Limpar esta aba' : 'Marcar esta aba'}
                        </button>
                        {tabPerms.map(p => renderPermRow(p))}
                      </div>
                    </details>
                  );
                }) : perms.map(p => renderPermRow(p))}
              </div>
              );
            })}
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary">
              💾 Salvar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AdminPanel;
