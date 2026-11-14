// frontend/src/components/AdminPanel/AdminDashboardTab.js
/**
 * Aba "Dashboard" do Painel Admin — snapshot operacional (atendimento/CSAT/
 * tarefas, GET /dashboard/stats) + análises recorrentes de um dashboard de
 * central de atendimento (GET /dashboard/trends): tendência de volume,
 * horário de pico, fila atual, carga por atendente, bot x humano, motivos
 * (tags) mais comuns e tendência diária de CSAT. Filtro de período por
 * intervalo de datas (ou atalho rápido) + conta/número com multi-seleção —
 * ambos aplicados às duas chamadas.
 *
 * Recebe `API` (axios já com baseURL /api/admin + Authorization) do
 * AdminPanel pai — mesmo padrão das outras abas, sem duplicar a instância.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import useClickOutside from '../../utils/useClickOutside';

const toISODate = (d) => d.toISOString().split('T')[0];

const QUICK_RANGES = [
  { label: 'Hoje', days: 1 },
  { label: '7 dias', days: 7 },
  { label: '14 dias', days: 14 },
  { label: '30 dias', days: 30 },
  { label: '90 dias', days: 90 },
];

const rangeFromDays = (days) => {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  return { start: toISODate(start), end: toISODate(end) };
};

const PROVIDER_NAMES = {
  meta_cloud_basic: 'Meta Cloud',
  meta_cloud_coexistence: 'Meta Coexistence',
  meta_cloud_mmlite: 'Meta MM Lite',
  meta_cloud_full: 'Meta Full Stack',
  baileys: 'Baileys',
  venom: 'Venom',
  whatsapp_web_js: 'WhatsApp-Web.js',
  wppconnect: 'WPPConnect',
};

const formatDuration = (seconds) => {
  if (seconds === null || seconds === undefined) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
};

const formatPercent = (ratio) => (ratio === null || ratio === undefined ? '—' : `${Math.round(ratio * 100)}%`);

const formatShortDate = (isoDate) => {
  const [, m, d] = isoDate.split('-');
  return `${d}/${m}`;
};

const StatCard = ({ icon, label, value, sub, alert }) => (
  <div className={`stat-card${alert ? ' alert' : ''}`}>
    <div className="stat-icon">{icon}</div>
    <div className="stat-info">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  </div>
);

// Gráfico de linha simples em SVG — sem lib externa (nenhuma no projeto).
// Todas as séries compartilham a mesma escala Y (nunca eixo duplo); ponto
// nulo quebra a linha (não interpola). Hover: linha-guia vertical + ponto
// destacado em cada série + caixa de tooltip com os valores exatos — o
// <title> nativo do navegador (usado antes) é lento pra aparecer e não
// mostra todas as séries de uma vez.
const LineChart = ({ labels, series, height = 260, formatValue = (v) => v }) => {
  const width = 900;
  const padding = { top: 14, right: 14, bottom: 26, left: 14 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const n = labels.length;
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  const allVals = series.flatMap(s => s.values.filter(v => v !== null && v !== undefined));
  const maxVal = Math.max(1, ...allVals, 0);

  const xAt = (i) => padding.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v) => padding.top + innerH - (v / maxVal) * innerH;

  const pathFor = (values) => {
    let d = '';
    let started = false;
    values.forEach((v, i) => {
      if (v === null || v === undefined) { started = false; return; }
      d += `${started ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
      started = true;
    });
    return d.trim();
  };

  const handleMove = (e) => {
    if (!svgRef.current || n === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < n; i++) {
      const dist = Math.abs(xAt(i) - relX);
      if (dist < nearestDist) { nearestDist = dist; nearest = i; }
    }
    setHoverIndex(nearest);
  };

  const labelStep = Math.max(1, Math.ceil(n / 10));

  const tooltipLines = hoverIndex === null ? [] : [
    labels[hoverIndex],
    ...series.map(s => {
      const v = s.values[hoverIndex];
      return `${s.name}: ${(v === null || v === undefined) ? '—' : formatValue(v)}`;
    }),
  ];
  const tooltipW = 168;
  const tooltipH = tooltipLines.length ? 10 + tooltipLines.length * 15 : 0;
  const tooltipX = hoverIndex === null ? 0 : Math.max(padding.left, Math.min(width - padding.right - tooltipW, xAt(hoverIndex) + 10));

  return (
    <>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={padding.left} x2={width - padding.right}
            y1={padding.top + innerH * (1 - f)} y2={padding.top + innerH * (1 - f)}
            stroke="var(--border-color)" strokeWidth="1" opacity="0.35"
          />
        ))}
        {series.map(s => (
          <path key={s.name} d={pathFor(s.values)} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {hoverIndex !== null && (
          <line
            x1={xAt(hoverIndex)} x2={xAt(hoverIndex)} y1={padding.top} y2={padding.top + innerH}
            stroke="var(--text-secondary)" strokeWidth="1" strokeDasharray="3,3" opacity="0.6"
          />
        )}
        {series.map(s => s.values.map((v, i) => (v === null || v === undefined) ? null : (
          <circle
            key={`${s.name}-${i}`} cx={xAt(i)} cy={yAt(v)}
            r={hoverIndex === i ? 5.5 : 3.5} fill={s.color}
            stroke={hoverIndex === i ? 'var(--bg-secondary)' : 'none'} strokeWidth={hoverIndex === i ? 2 : 0}
          />
        )))}
        {labels.map((lab, i) => (i % labelStep === 0) ? (
          <text key={i} x={xAt(i)} y={height - 6} fontSize="11" textAnchor="middle" fill="var(--text-secondary)">{lab}</text>
        ) : null)}
        {hoverIndex !== null && (
          <g pointerEvents="none">
            <rect x={tooltipX} y={padding.top} width={tooltipW} height={tooltipH} rx="6" fill="var(--bg-primary)" stroke="var(--border-color)" />
            {tooltipLines.map((line, i) => (
              <text
                key={i} x={tooltipX + 10} y={padding.top + 17 + i * 15}
                fontSize={i === 0 ? 10 : 11.5} fontWeight={i === 0 ? 400 : 700}
                fill={i === 0 ? 'var(--text-secondary)' : 'var(--text-primary)'}
              >
                {line}
              </text>
            ))}
          </g>
        )}
      </svg>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map(s => (
            <span className="chart-legend-item" key={s.name}>
              <span className="chart-legend-dot" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </>
  );
};

// Barras verticais — uma série, magnitude (horário de pico). Hover: barra em
// foco (as outras esmaecem) + caixa de tooltip acima com o valor exato.
const BarChart = ({ labels, values, color, labelEvery = 2, height = 220 }) => {
  const width = 900;
  const padding = { top: 12, right: 6, bottom: 24, left: 6 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const maxVal = Math.max(1, ...values);
  const barW = innerW / values.length;
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  const handleMove = (e) => {
    if (!svgRef.current || values.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const idx = Math.max(0, Math.min(values.length - 1, Math.floor((relX - padding.left) / barW)));
    setHoverIndex(idx);
  };

  const tooltipW = 96;
  const tooltipH = 38;
  const tooltipX = hoverIndex === null ? 0 : Math.max(
    padding.left,
    Math.min(width - padding.right - tooltipW, padding.left + hoverIndex * barW + barW / 2 - tooltipW / 2),
  );

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      onMouseMove={handleMove}
      onMouseLeave={() => setHoverIndex(null)}
    >
      {values.map((v, i) => {
        const h = (v / maxVal) * innerH;
        const x = padding.left + i * barW;
        const y = padding.top + innerH - h;
        return (
          <rect
            key={i} x={x + 1.5} y={y} width={Math.max(1, barW - 3)} height={Math.max(0, h)} rx="3" fill={color}
            opacity={hoverIndex === null || hoverIndex === i ? 1 : 0.4}
          />
        );
      })}
      {labels.map((lab, i) => (i % labelEvery === 0) ? (
        <text key={i} x={padding.left + i * barW + barW / 2} y={height - 6} fontSize="10" textAnchor="middle" fill="var(--text-secondary)">{lab}</text>
      ) : null)}
      {hoverIndex !== null && (
        <g pointerEvents="none">
          <rect x={tooltipX} y={padding.top} width={tooltipW} height={tooltipH} rx="6" fill="var(--bg-primary)" stroke="var(--border-color)" />
          <text x={tooltipX + 10} y={padding.top + 16} fontSize="10" fill="var(--text-secondary)">{labels[hoverIndex]}</text>
          <text x={tooltipX + 10} y={padding.top + 30} fontSize="13" fontWeight="700" fill="var(--text-primary)">{values[hoverIndex]}</text>
        </g>
      )}
    </svg>
  );
};

// Lista de barras horizontais ranqueadas — mesmo padrão visual de "Providers
// em Uso" (reaproveita .provider-stat/.provider-bar/.provider-bar-fill), só
// que com cor por item (tag tem cor própria) em vez de uma cor fixa.
const RankedBarList = ({ items, maxCount }) => (
  <div className="providers-list">
    {items.map(item => (
      <div key={item.name} className="provider-stat">
        <span className="provider-name">{item.name}</span>
        <div className="provider-bar">
          <div className="provider-bar-fill" style={{ width: `${(item.count / maxCount) * 100}%`, background: item.color }} />
        </div>
        <span className="provider-count">{item.count}</span>
      </div>
    ))}
  </div>
);

const EmptyNote = ({ children }) => (
  <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{children}</p>
);

// Dropdown multi-seleção de contas/números — botão resume a seleção, painel
// com checkbox por conta + atalhos "Todas"/"Nenhuma". Fecha ao clicar fora
// (mesmo hook usado nos outros popovers do app, ver useClickOutside.js).
const AccountMultiSelect = ({ accounts, selectedIds, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);

  const toggle = (id) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id]);
  };

  const summary = selectedIds.length === 0
    ? 'Todas as contas'
    : selectedIds.length === 1
      ? (accounts.find(a => a.id === selectedIds[0])?.account_name || '1 conta')
      : `${selectedIds.length} contas selecionadas`;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="dashboard-multiselect-trigger" onClick={() => setOpen(o => !o)}>
        {summary} ▾
      </button>
      {open && (
        <div className="dashboard-multiselect-panel">
          <div className="dashboard-multiselect-actions">
            <button type="button" onClick={() => onChange([])}>Todas</button>
            <button type="button" onClick={() => onChange(accounts.map(a => a.id))}>Selecionar todas</button>
          </div>
          {accounts.map(a => (
            <label key={a.id} className="dashboard-multiselect-item">
              <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => toggle(a.id)} />
              {a.account_name} ({a.phone_number})
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

const AdminDashboardTab = ({ API }) => {
  const initialRange = rangeFromDays(7);
  const [startDate, setStartDate] = useState(initialRange.start);
  const [endDate, setEndDate] = useState(initialRange.end);
  const [accountIds, setAccountIds] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [stats, setStats] = useState(null);
  const [trends, setTrends] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    API.get('/accounts').then(res => setAccounts(res.data || [])).catch(() => setAccounts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set('start_date', startDate);
    params.set('end_date', endDate);
    accountIds.forEach(id => params.append('account_ids', id));
    const qs = params.toString();
    Promise.all([
      API.get(`/dashboard/stats?${qs}`),
      API.get(`/dashboard/trends?${qs}`),
    ])
      .then(([statsRes, trendsRes]) => { setStats(statsRes.data); setTrends(trendsRes.data); })
      .catch(() => { setStats(null); setTrends(null); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, accountIds]);

  useEffect(() => { load(); }, [load]);

  const applyQuickRange = (days) => {
    const r = rangeFromDays(days);
    setStartDate(r.start);
    setEndDate(r.end);
  };

  const maxTagCount = trends ? Math.max(1, ...trends.top_tags.map(t => t.count)) : 1;
  const maxAccountCount = trends ? Math.max(1, ...trends.volume_by_account.map(a => a.count)) : 1;
  const botTotal = trends ? trends.bot_only_count + trends.with_human_count : 0;
  const periodLabel = stats ? `${formatShortDate(stats.start_date)} a ${formatShortDate(stats.end_date)}` : '';

  return (
    <div className="admin-dashboard">
      <h2>📊 Dashboard do Sistema</h2>

      <div className="dashboard-filters">
        <div className="dashboard-filter-group">
          <label>Atalho</label>
          <div className="dashboard-quick-range">
            {QUICK_RANGES.map(qr => (
              <button
                key={qr.label} type="button"
                className={rangeFromDays(qr.days).start === startDate && rangeFromDays(qr.days).end === endDate ? 'active' : ''}
                onClick={() => applyQuickRange(qr.days)}
              >
                {qr.label}
              </button>
            ))}
          </div>
        </div>
        <div className="dashboard-filter-group">
          <label>De</label>
          <input type="date" value={startDate} max={endDate} onChange={e => setStartDate(e.target.value)} />
        </div>
        <div className="dashboard-filter-group">
          <label>Até</label>
          <input type="date" value={endDate} min={startDate} max={toISODate(new Date())} onChange={e => setEndDate(e.target.value)} />
        </div>
        <div className="dashboard-filter-group">
          <label>Conta / número</label>
          <AccountMultiSelect accounts={accounts} selectedIds={accountIds} onChange={setAccountIds} />
        </div>
      </div>

      {loading && !stats && <EmptyNote>Carregando…</EmptyNote>}

      {stats && trends && (
        <>
          <h3 className="dashboard-section-title">🎧 Atendimento agora</h3>
          <div className="stats-grid">
            <StatCard icon="⏳" label="Na fila, sem atendente" value={stats.attendance.open_unassigned} />
            <StatCard icon="🧑‍💻" label="Em atendimento" value={stats.attendance.open_assigned} />
            <StatCard icon="💤" label="Aguardando o cliente" value={stats.attendance.pending_recent} sub="menos de 24h" />
            <StatCard
              icon="🕸️" label="Paradas (sem resposta do cliente)" value={stats.attendance.pending_stale}
              sub="24h ou mais — provavelmente abandonadas"
            />
            <StatCard
              icon="🚨" label="Estourando SLA agora" value={stats.attendance.sla_breaches_now}
              alert={stats.attendance.sla_breaches_now > 0}
              sub={`Esperando > ${stats.attendance.sla_wait_minutes}min sem atendente`}
            />
            <StatCard icon="" label={`Resolvidas (${periodLabel})`} value={stats.attendance.resolved_count} />
            <StatCard
              icon="⏱️" label="Tempo médio de resolução" value={formatDuration(stats.attendance.avg_resolution_seconds)}
              sub={`Espera: ${formatDuration(stats.attendance.avg_wait_seconds)}`}
            />
          </div>

          <h3 className="dashboard-section-title">📈 Volume ({periodLabel})</h3>
          <div className="chart-card">
            <h3>Tendência — criadas x resolvidas</h3>
            {trends.daily_volume.every(d => d.created === 0 && d.resolved === 0) ? (
              <EmptyNote>Sem conversas no período.</EmptyNote>
            ) : (
              <LineChart
                height={340}
                labels={trends.daily_volume.map(d => formatShortDate(d.date))}
                series={[
                  { name: 'Criadas', color: 'var(--info-color, #34B7F1)', values: trends.daily_volume.map(d => d.created) },
                  { name: 'Resolvidas', color: 'var(--brand-orange)', values: trends.daily_volume.map(d => d.resolved) },
                ]}
              />
            )}
          </div>

          <div className="chart-card">
            <h3>Volume por hora do dia</h3>
            {trends.hourly_volume.every(h => h.count === 0) ? (
              <EmptyNote>Sem mensagens recebidas no período.</EmptyNote>
            ) : (
              <BarChart
                height={260}
                labels={trends.hourly_volume.map(h => `${h.hour}h`)}
                values={trends.hourly_volume.map(h => h.count)}
                color="var(--brand-orange)"
              />
            )}
          </div>

          <h3 className="dashboard-section-title">⏳ Fila e carga agora</h3>

          <div className="charts-section">
            <div className="chart-card">
              <h3>Mais antigas esperando</h3>
              {trends.oldest_waiting.length === 0 ? (
                <EmptyNote>Ninguém esperando sem atendente agora. 🎉</EmptyNote>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                      <th style={{ padding: '6px 8px' }}>Contato</th>
                      <th style={{ padding: '6px 8px' }}>Conta</th>
                      <th style={{ padding: '6px 8px' }}>Esperando há</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trends.oldest_waiting.map(w => (
                      <tr key={w.conversation_id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                        <td style={{ padding: '6px 8px' }}>{w.contact_name}</td>
                        <td style={{ padding: '6px 8px' }}>{w.account_name}</td>
                        <td style={{ padding: '6px 8px' }}>{formatDuration(w.wait_seconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="chart-card">
              <h3>Carga por atendente</h3>
              {trends.agent_workload.length === 0 ? (
                <EmptyNote>Ninguém com conversa em atendimento agora.</EmptyNote>
              ) : (
                <RankedBarList
                  items={trends.agent_workload.map(a => ({ name: a.full_name, count: a.open_count, color: 'var(--brand-orange)' }))}
                  maxCount={Math.max(1, ...trends.agent_workload.map(a => a.open_count))}
                />
              )}
            </div>
          </div>

          <h3 className="dashboard-section-title">Satisfação (CSAT, {periodLabel})</h3>
          <div className="stats-grid">
            <StatCard icon="" label="Nota média" value={stats.csat.avg_rating ?? '—'} sub={stats.csat.avg_rating ? 'de 5' : 'sem respostas no período'} />
            <StatCard icon="📝" label="Respostas recebidas" value={stats.csat.response_count} />
            <StatCard icon="📈" label="Taxa de resposta" value={formatPercent(stats.csat.response_rate)} />
          </div>

          <div className="charts-section">
            <div className="chart-card">
              <h3>Tendência diária</h3>
              {trends.csat_daily.every(d => d.count === 0) ? (
                <EmptyNote>Sem respostas de CSAT no período.</EmptyNote>
              ) : (
                <LineChart
                  labels={trends.csat_daily.map(d => formatShortDate(d.date))}
                  series={[{ name: 'Nota média', color: 'var(--brand-orange)', values: trends.csat_daily.map(d => d.avg_rating) }]}
                  formatValue={(v) => `${v} / 5`}
                  height={200}
                />
              )}
            </div>

            <div className="chart-card">
              <h3>🧑‍💻 Precisou de humano — resolvidas no período</h3>
              {botTotal === 0 ? (
                <EmptyNote>Nenhuma conversa resolvida no período.</EmptyNote>
              ) : (
                <>
                  <div style={{ display: 'flex', height: 32, borderRadius: 6, overflow: 'hidden', marginTop: 8 }}>
                    <div style={{ width: `${(trends.with_human_count / botTotal) * 100}%`, background: 'var(--success-color)' }} title={`Respondida por humano: ${trends.with_human_count}`} />
                    <div style={{ width: `${(trends.bot_only_count / botTotal) * 100}%`, background: 'var(--warning-border)' }} title={`Nunca respondida por humano: ${trends.bot_only_count}`} />
                  </div>
                  <div className="chart-legend">
                    <span className="chart-legend-item"><span className="chart-legend-dot" style={{ background: 'var(--success-color)' }} />Respondida por humano: {trends.with_human_count} ({formatPercent(trends.with_human_count / botTotal)})</span>
                    <span className="chart-legend-item"><span className="chart-legend-dot" style={{ background: 'var(--warning-border)' }} />Nunca respondida por humano: {trends.bot_only_count} ({formatPercent(trends.bot_only_count / botTotal)})</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 8 }}>
                    Baseado em quem mandou a 1ª resposta — só fica preciso pra conversas resolvidas a partir de hoje (histórico anterior não tinha esse dado gravado).
                  </p>
                </>
              )}
            </div>
          </div>

          <h3 className="dashboard-section-title">📋 Tarefas internas</h3>
          <div className="stats-grid">
            <StatCard icon="📌" label="Pendentes" value={stats.tasks.pending} />
            <StatCard icon="⚠️" label="Atrasadas" value={stats.tasks.overdue} alert={stats.tasks.overdue > 0} />
            <StatCard icon="" label={`Concluídas (${periodLabel})`} value={stats.tasks.completed_count} />
          </div>

          <h3 className="dashboard-section-title">🏷️ Motivos e canais ({periodLabel})</h3>
          <div className="charts-section">
            <div className="chart-card">
              <h3>Principais motivos (tags)</h3>
              {trends.top_tags.length === 0 ? (
                <EmptyNote>Nenhuma conversa com etiqueta no período.</EmptyNote>
              ) : (
                <RankedBarList items={trends.top_tags} maxCount={maxTagCount} />
              )}
            </div>
            <div className="chart-card">
              <h3>Volume por conta/número</h3>
              {trends.volume_by_account.length === 0 ? (
                <EmptyNote>Sem conversas no período.</EmptyNote>
              ) : (
                <RankedBarList
                  items={trends.volume_by_account.map(a => ({ name: `${a.account_name} (${a.phone_number})`, count: a.count, color: 'var(--brand-navy-2, #273449)' }))}
                  maxCount={maxAccountCount}
                />
              )}
            </div>
          </div>

          <h3 className="dashboard-section-title">🗂️ Visão geral do sistema</h3>
          <div className="stats-grid">
            <StatCard icon="👥" label="Usuários Totais" value={stats.total_users} sub={`${stats.active_users} ativos`} />
            <StatCard icon="📱" label="Contas WhatsApp" value={stats.total_accounts} />
            <StatCard icon="💬" label="Mensagens Hoje" value={stats.total_messages_today} sub={`${stats.total_messages_month} este mês`} />
          </div>

          <div className="chart-card">
            <h3>📊 Providers em Uso</h3>
            <div className="providers-list">
              {Object.entries(stats.providers_usage).map(([provider, count]) => (
                <div key={provider} className="provider-stat">
                  <span className="provider-name">{PROVIDER_NAMES[provider] || provider}</span>
                  <div className="provider-bar">
                    <div className="provider-bar-fill" style={{ width: `${(count / stats.total_accounts) * 100}%` }} />
                  </div>
                  <span className="provider-count">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default AdminDashboardTab;
