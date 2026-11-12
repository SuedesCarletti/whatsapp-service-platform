/**
 * ReportsPanel — Relatórios (fila/SLA, CSAT, tarefas internas)
 *
 * Três abas sobre o mesmo período (dias): Atendimento (tempo médio de
 * espera/resolução, SLA, ranking por atendente — dado de /api/attendance/
 * reports), CSAT (nota média, distribuição 1-5, taxa de resposta,
 * comentários, ranking por atendente — mesmo endpoint, chave `csat`) e
 * Tarefas internas (conclusão, tempo médio, atrasadas, aprovação/reprovação,
 * ranking por responsável — /api/internal-chats/tasks/reports). Reaproveita
 * as classes CSS de AnalyticsDashboard.css (analytics-overlay/card/grid/etc.)
 * — mesmo padrão visual, sem duplicar estilo.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { MdClose, MdRefresh, MdSchedule, MdCheckCircle, MdWarning, MdPeople, MdStar, MdAssignment, MdThumbUp, MdThumbDown } from 'react-icons/md';
import { BsGraphUp } from 'react-icons/bs';
import apiService from '../services/api';
import '../styles/AnalyticsDashboard.css';

const formatDuration = (seconds) => {
  if (seconds === null || seconds === undefined) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
};

const formatPercent = (ratio) => (ratio === null || ratio === undefined ? '—' : `${Math.round(ratio * 100)}%`);

const STATUS_LABELS = { open: 'Abertas', pending: 'Pendentes', resolved: 'Resolvidas' };
const TASK_STATUS_LABELS = { pending: 'Pendentes', paused: 'Pausadas', done: 'Concluídas' };

const TABS = [
  { key: 'atendimento', label: 'Atendimento' },
  { key: 'csat', label: 'CSAT' },
  { key: 'tarefas', label: 'Tarefas internas' },
];

const renderMetric = (title, value, icon, color, subtitle) => (
  <div className="analytics-card" key={title}>
    <div className="analytics-card-header">
      <div className={`analytics-card-icon ${color}`}>{icon}</div>
      <div className="analytics-card-title">{title}</div>
    </div>
    <div className="analytics-card-value">{value}</div>
    {subtitle && <div className="analytics-card-subtitle">{subtitle}</div>}
  </div>
);

const EmptyNote = ({ children }) => (
  <p style={{ color: 'var(--text-secondary, #888)', fontSize: 13 }}>{children}</p>
);

const RatingStars = ({ rating }) => (
  <span style={{ color: '#f5a623', letterSpacing: 1 }}>
    {'★'.repeat(rating)}{'☆'.repeat(5 - rating)}
  </span>
);

const AtendimentoTab = ({ data }) => (
  <>
    <div className="analytics-section">
      <h3 className="analytics-section-title">Visão geral</h3>
      <div className="analytics-grid">
        {renderMetric('Conversas no período', data.total_conversations, <MdPeople size={20} />, 'blue')}
        {renderMetric('Tempo médio de espera', formatDuration(data.avg_wait_seconds), <MdSchedule size={20} />, 'orange', 'Abertura até ser atribuída')}
        {renderMetric('Tempo médio de resolução', formatDuration(data.avg_resolution_seconds), <MdCheckCircle size={20} />, 'green', 'Abertura até marcada Resolvida')}
        {renderMetric('Estourando SLA agora', data.sla_breaches_now, <MdWarning size={20} />, data.sla_breaches_now > 0 ? 'red' : 'green', `Esperando > ${data.sla_wait_minutes}min sem atribuição`)}
      </div>
    </div>

    <div className="analytics-section">
      <h3 className="analytics-section-title">Por status</h3>
      <div className="analytics-grid">
        {Object.entries(data.status_counts || {}).map(([key, count]) => (
          renderMetric(STATUS_LABELS[key] || key, count, <MdSchedule size={20} />, 'blue')
        ))}
      </div>
    </div>

    <div className="analytics-section">
      <h3 className="analytics-section-title">Resolvidas por atendente</h3>
      {(!data.agents || data.agents.length === 0) ? (
        <EmptyNote>Nenhuma conversa resolvida no período.</EmptyNote>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color, #ddd)' }}>
              <th style={{ padding: '6px 8px' }}>Atendente</th>
              <th style={{ padding: '6px 8px' }}>Resolvidas</th>
              <th style={{ padding: '6px 8px' }}>Tempo médio de resolução</th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map(a => (
              <tr key={a.user_id} style={{ borderBottom: '1px solid var(--border-color, #eee)' }}>
                <td style={{ padding: '6px 8px' }}>{a.full_name}</td>
                <td style={{ padding: '6px 8px' }}>{a.resolved_count}</td>
                <td style={{ padding: '6px 8px' }}>{formatDuration(a.avg_resolution_seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </>
);

const CsatTab = ({ csat }) => {
  if (!csat) return <EmptyNote>Sem dados de CSAT no período.</EmptyNote>;
  const maxCount = Math.max(1, ...Object.values(csat.distribution || {}).map(Number));

  return (
    <>
      <div className="analytics-section">
        <h3 className="analytics-section-title">Visão geral</h3>
        <div className="analytics-grid">
          {renderMetric('Nota média', csat.avg_rating ?? '—', <MdStar size={20} />, 'orange', csat.avg_rating ? 'de 5' : null)}
          {renderMetric('Pesquisas enviadas', csat.sent_count, <MdSchedule size={20} />, 'blue')}
          {renderMetric('Respostas recebidas', csat.response_count, <MdCheckCircle size={20} />, 'green')}
          {renderMetric('Taxa de resposta', formatPercent(csat.response_rate), <BsGraphUp size={20} />, 'purple')}
        </div>
      </div>

      <div className="analytics-section">
        <h3 className="analytics-section-title">Distribuição das notas</h3>
        {csat.response_count === 0 ? (
          <EmptyNote>Nenhuma resposta de CSAT no período.</EmptyNote>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[5, 4, 3, 2, 1].map(n => {
              const count = Number(csat.distribution?.[String(n)] || 0);
              return (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <span style={{ width: 28 }}>{n}★</span>
                  <div style={{ flex: 1, background: 'var(--border-color, #eee)', borderRadius: 4, height: 10, overflow: 'hidden' }}>
                    <div style={{
                      width: `${(count / maxCount) * 100}%`, height: '100%',
                      background: n >= 4 ? '#2ecc71' : n === 3 ? '#f5a623' : '#e74c3c',
                    }} />
                  </div>
                  <span style={{ width: 24, textAlign: 'right', color: 'var(--text-secondary, #888)' }}>{count}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="analytics-section">
        <h3 className="analytics-section-title">Por atendente</h3>
        {(!csat.agents || csat.agents.length === 0) ? (
          <EmptyNote>Nenhuma resposta atribuída a um atendente no período.</EmptyNote>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color, #ddd)' }}>
                <th style={{ padding: '6px 8px' }}>Atendente</th>
                <th style={{ padding: '6px 8px' }}>Respostas</th>
                <th style={{ padding: '6px 8px' }}>Nota média</th>
              </tr>
            </thead>
            <tbody>
              {csat.agents.map(a => (
                <tr key={a.user_id} style={{ borderBottom: '1px solid var(--border-color, #eee)' }}>
                  <td style={{ padding: '6px 8px' }}>{a.full_name}</td>
                  <td style={{ padding: '6px 8px' }}>{a.response_count}</td>
                  <td style={{ padding: '6px 8px' }}>{a.avg_rating}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="analytics-section">
        <h3 className="analytics-section-title">Comentários recentes</h3>
        {(!csat.recent_comments || csat.recent_comments.length === 0) ? (
          <EmptyNote>Nenhum comentário no período.</EmptyNote>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {csat.recent_comments.map((c, i) => (
              <div key={i} style={{ border: '1px solid var(--border-color, #eee)', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <RatingStars rating={c.rating} />
                  <span style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>
                    {new Date(c.created_at).toLocaleString('pt-BR')}
                  </span>
                </div>
                <div style={{ fontSize: 13 }}>{c.comment}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
};

const TarefasTab = ({ data }) => {
  if (!data) return <EmptyNote>Sem dados de tarefas no período.</EmptyNote>;
  return (
    <>
      <div className="analytics-section">
        <h3 className="analytics-section-title">Visão geral</h3>
        <div className="analytics-grid">
          {renderMetric('Tarefas criadas', data.total_tasks, <MdAssignment size={20} />, 'blue')}
          {renderMetric('Taxa de conclusão', formatPercent(data.completion_rate), <MdCheckCircle size={20} />, 'green')}
          {renderMetric('Tempo médio de conclusão', formatDuration(data.avg_completion_seconds), <MdSchedule size={20} />, 'orange', 'Criação até concluída')}
          {renderMetric('Atrasadas agora', data.overdue_now, <MdWarning size={20} />, data.overdue_now > 0 ? 'red' : 'green', 'Prazo vencido, ainda não concluída')}
        </div>
      </div>

      <div className="analytics-section">
        <h3 className="analytics-section-title">Aprovação</h3>
        <div className="analytics-grid">
          {renderMetric('Aprovadas', data.approved_count, <MdThumbUp size={20} />, 'green')}
          {renderMetric('Reprovadas', data.rejected_count, <MdThumbDown size={20} />, data.rejected_count > 0 ? 'red' : 'green')}
        </div>
      </div>

      <div className="analytics-section">
        <h3 className="analytics-section-title">Por status</h3>
        <div className="analytics-grid">
          {Object.entries(data.status_counts || {}).map(([key, count]) => (
            renderMetric(TASK_STATUS_LABELS[key] || key, count, <MdAssignment size={20} />, 'blue')
          ))}
        </div>
      </div>

      <div className="analytics-section">
        <h3 className="analytics-section-title">Por responsável</h3>
        {(!data.assignees || data.assignees.length === 0) ? (
          <EmptyNote>Nenhuma tarefa atribuída no período.</EmptyNote>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color, #ddd)' }}>
                <th style={{ padding: '6px 8px' }}>Responsável</th>
                <th style={{ padding: '6px 8px' }}>Total</th>
                <th style={{ padding: '6px 8px' }}>Concluídas</th>
                <th style={{ padding: '6px 8px' }}>Taxa</th>
                <th style={{ padding: '6px 8px' }}>Tempo médio</th>
                <th style={{ padding: '6px 8px' }}>Atrasadas</th>
              </tr>
            </thead>
            <tbody>
              {data.assignees.map(a => (
                <tr key={a.user_id} style={{ borderBottom: '1px solid var(--border-color, #eee)' }}>
                  <td style={{ padding: '6px 8px' }}>{a.full_name}</td>
                  <td style={{ padding: '6px 8px' }}>{a.total}</td>
                  <td style={{ padding: '6px 8px' }}>{a.done}</td>
                  <td style={{ padding: '6px 8px' }}>{formatPercent(a.completion_rate)}</td>
                  <td style={{ padding: '6px 8px' }}>{formatDuration(a.avg_completion_seconds)}</td>
                  <td style={{ padding: '6px 8px' }}>{a.overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
};

const ReportsPanel = ({ onClose }) => {
  const [tab, setTab] = useState('atendimento');
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [taskData, setTaskData] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiService.getAttendanceReports(days),
      apiService.getInternalTaskReports(days),
    ])
      .then(([attendance, tasks]) => { setData(attendance); setTaskData(tasks); })
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="analytics-overlay" onClick={onClose}>
      <div className="analytics-modal" onClick={(e) => e.stopPropagation()}>
        <div className="analytics-header">
          <div className="analytics-title">
            <BsGraphUp size={24} />
            <h2>Relatórios</h2>
          </div>
          <div className="analytics-actions">
            <button className="analytics-btn-refresh" onClick={load} disabled={loading} title="Atualizar">
              <MdRefresh size={20} />
            </button>
            <button className="analytics-close" onClick={onClose}>
              <MdClose size={24} />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid var(--border-color, #ddd)' }}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '10px 14px', fontSize: 13, fontWeight: tab === t.key ? 600 : 400,
                background: 'none', border: 'none', cursor: 'pointer',
                color: tab === t.key ? 'var(--brand-orange, #0EA5A4)' : 'var(--text-secondary, #888)',
                borderBottom: tab === t.key ? '2px solid var(--brand-orange, #0EA5A4)' : '2px solid transparent',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="analytics-filters">
          <div className="analytics-filter-group">
            <label>Período</label>
            <select value={days} onChange={e => setDays(Number(e.target.value))}>
              <option value={1}>Últimas 24h</option>
              <option value={7}>Últimos 7 dias</option>
              <option value={30}>Últimos 30 dias</option>
              <option value={90}>Últimos 90 dias</option>
            </select>
          </div>
        </div>

        <div className="analytics-body">
          {loading ? (
            <div className="analytics-loading"><div className="analytics-spinner" /></div>
          ) : !data ? (
            <div className="analytics-error">Não foi possível carregar o relatório.</div>
          ) : (
            <>
              {tab === 'atendimento' && <AtendimentoTab data={data} />}
              {tab === 'csat' && <CsatTab csat={data.csat} />}
              {tab === 'tarefas' && <TarefasTab data={taskData} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReportsPanel;
