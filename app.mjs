const el = id => document.getElementById(id);
const money = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const number = new Intl.NumberFormat('es-ES');
const decimal = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('es-ES', { style: 'percent', maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const time = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const asDate = value => value ? date.format(new Date(value)) : '—';
const asRate = value => value == null ? '—' : percent.format(value);
const signed = (value, format) => (value > 0 ? '+' : '') + format(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const fill = (id, html) => { el(id).innerHTML = html; };
const empty = text => '<p class="empty">' + escape(text) + '</p>';
const statusLabel = { draft: 'Pendiente', running: 'En curso', dismissed: 'Descartada', complete: 'Finalizado' };
const outcomes = { collecting: 'Recogiendo datos', variant: 'Gana la variante B', control: 'Gana el control A', inconclusive: 'Resultado inconcluso' };
const channelClass = { 'Meta Ads': 'meta', 'Google Ads': 'google', Email: 'email' };
const views = {
  resumen: ['Vista general', 'Rendimiento de campañas', 'Mide tus campañas y convierte las señales en experimentos.'],
  campanas: ['Campañas', 'Campañas', 'Compara resultados por canal y exporta las métricas diarias.'],
  automatizacion: ['Automatización', 'Automatización', 'El análisis compara los últimos 7 días con los 7 anteriores. Revisa la evidencia antes de aprobar.'],
  experimentos: ['Experimentos', 'Experimentos A/B', 'Compara el control y la variante con tráfico sintético y un tamaño de muestra fijo.'],
  actividad: ['Actividad', 'Actividad', 'Consulta el registro de cambios del conjunto de datos activo.'],
};

let scope = localStorage.getItem('campaign-loop-scope') === 'workspace' ? 'workspace' : 'demo';
let snapshot;
let loading = 0;
let mutating = false;
let toastTimeout;
const browserMode = document.documentElement.dataset.runtime === 'browser';
let browserStore;
function getBrowserStore() {
  browserStore ??= import('./browser-store.mjs').then(module => module.createBrowserStore());
  return browserStore;
}

async function request(path, { method = 'GET', body, dataset = scope, filters = {} } = {}) {
  if (browserMode) return (await getBrowserStore()).request(path, { body, dataset, filters });
  const query = new URLSearchParams({ scope: dataset, ...filters });
  const response = await fetch(path + '?' + query, { method, body, headers: { 'X-Campaign-Loop': '1' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'No se pudo completar la operación.');
  return result;
}

function toast(message) {
  clearTimeout(toastTimeout);
  el('toast').textContent = message;
  el('toast').hidden = false;
  toastTimeout = setTimeout(() => { el('toast').hidden = true; }, 4700);
}

function currentView() {
  const requested = location.hash.slice(1).split('/')[0];
  return Object.hasOwn(views, requested) ? requested : 'resumen';
}

function renderRoute() {
  const view = currentView();
  for (const item of Object.keys(views)) el('view-' + item).hidden = item !== view;
  el('filters').hidden = !['resumen', 'campanas'].includes(view);
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  ['breadcrumb', 'page-title', 'page-description'].forEach((id, i) => { el(id).textContent = views[view][i]; });
  drawChart();
  const proposalId = location.hash.split('/')[1];
  if (view === 'automatizacion' && /^[a-f0-9]{20}$/.test(proposalId || '')) {
    const proposal = el('proposal-' + proposalId);
    proposal?.focus();
    proposal?.scrollIntoView({ block: 'center' });
  } else window.scrollTo(0, 0);
}

async function refresh() {
  const version = ++loading;
  const result = await request('/api/state', { filters: { days: el('days').value, channel: el('channel').value } });
  if (version !== loading) return;
  if (JSON.stringify(snapshot) !== JSON.stringify(result)) {
    snapshot = result;
    render();
  }
  el('content').setAttribute('aria-busy', 'false');
}

function renderMetrics() {
  const metrics = [
    ['spend', 'Gasto', '€', value => money.format(value / 100)],
    ['revenue', 'Ingresos', '▥', value => money.format(value / 100)],
    ['cpa', 'Coste por adquisición', '◎', value => cents.format(value / 100)],
    ['roas', 'ROAS', '◈', value => decimal.format(value) + '×'],
  ];
  fill('metrics', metrics.map(([key, title, icon, format]) => {
    const value = snapshot.metrics[key];
    const previous = snapshot.previous[key];
    const change = snapshot.baseline && previous > 0 && value !== null ? value / previous - 1 : null;
    const direction = change === 0 || key === 'spend' ? '' : (change > 0) !== (key === 'cpa') ? 'good' : 'bad';
    return '<article class="metric"><div class="metric-label"><span class="metric-icon" aria-hidden="true">' + icon +
      '</span>' + title + '</div><div class="metric-value">' + (snapshot.trend.some(item => item.metrics) && value !== null ? format(value) : '—') + '</div>' +
      (change !== null ? '<span class="metric-change ' + direction + '">' + signed(change, percent.format) +
        '</span><span class="metric-compare">vs. periodo anterior</span>' : '<span class="metric-compare">Sin comparación disponible</span>') + '</article>';
  }).join(''));
}

function campaignTable(campaigns) {
  if (!campaigns.length) return empty('No hay campañas para el periodo y canal seleccionados.');
  return '<table><thead><tr>' + ['Campaña', 'Canal', 'CTR', 'Conversiones', 'Gasto', 'Ingresos', 'CPA', 'ROAS']
    .map(title => '<th scope="col">' + title + '</th>').join('') + '</tr></thead><tbody>' +
    campaigns.map(c => '<tr><td>' + escape(c.name) + '</td><td><span class="chip ' + channelClass[c.channel] + '">' +
      escape(c.channel) + '</span></td><td>' + asRate(c.ctr) + '</td><td>' + number.format(c.conversions) +
      '</td><td>' + money.format(c.spend / 100) + '</td><td>' + money.format(c.revenue / 100) + '</td><td>' +
      (c.cpa === null ? '—' : cents.format(c.cpa / 100)) + '</td><td>' +
      (c.roas === null ? '—' : decimal.format(c.roas) + '×') + '</td></tr>').join('') + '</tbody></table>';
}

function metricLabel(proposal) {
  return ({ cpa: 'CPA', ctr: 'CTR', cvr: 'Conversión' })[proposal.metric];
}

function reading(proposal, value) {
  return proposal.metric === 'cpa' ? cents.format(value / 100) : asRate(value);
}

function proposalCard(p) {
  return '<article class="panel detail-card" id="proposal-' + p.id + '" tabindex="-1"><div class="detail-top"><div><h2>' + escape(p.title) +
    '</h2><p>' + escape(p.campaign) + ' · ' + escape(p.channel) + '</p></div><span class="chip ' + (p.status === 'draft' ? 'hot' : '') + '">' +
    statusLabel[p.status] + '</span></div><div class="evidence"><strong>' + metricLabel(p) + ' ' +
    signed(p.change, percent.format) + '</strong><span>' + reading(p, p.before) + ' antes · ' + reading(p, p.after) +
    ' ahora</span><span>Ventana hasta el ' + asDate(p.end) + '</span></div><p><strong>Hipótesis</strong> ' + escape(p.brief.hypothesis) +
    '</p><p><strong>Prueba propuesta</strong> ' + escape(p.brief.action) +
    '</p>' + (p.brief.variant ? '<div class="variant"><strong>Borrador de la variante</strong><p>' + escape(p.brief.variant) + '</p></div>' : '') +
    '<div class="card-actions"><span class="chip">' +
    escape(p.source) + '</span>' + (p.status === 'draft' ? action(p, 'approve', 'Aprobar prueba A/B', 'primary') +
      action(p, 'dismiss', 'Descartar', 'secondary') : p.experiment ? '<a class="button secondary" href="#experimentos">Ver experimentos</a>' : '') +
    '</div></article>';
}

function action(p, operation, label, style) {
  return '<button type="button" class="button ' + style + '" data-action="' + operation + '" data-id="' + p.id + '">' + label + '</button>';
}

function experimentCard(p) {
  const x = p.experiment;
  const ci = x.result.interval;
  const clickTest = p.metric === 'ctr';
  const units = clickTest ? 'impresiones' : 'visitas';
  const events = clickTest ? 'clics' : 'conversiones';
  const metric = clickTest ? 'CTR' : p.metric === 'cpa' ? 'Conversión por visita, indicador indirecto del CPA' : 'Conversión por visita';
  const points = value => signed(value * 100, decimal.format) + ' pp';
  const arm = (label, data) => '<div class="arm"><span>' + label + '</span><b>' +
    asRate(data.n ? data.x / data.n : null) + '</b><p>' + number.format(data.x) + ' ' + events + ' · ' +
    number.format(data.n) + ' ' + units + '</p></div>';
  return '<article class="panel detail-card"><div class="detail-top"><div><h2>' + escape(p.campaign) +
    '</h2><p>' + escape(p.channel) + ' · ' + metric + ' · Tráfico simulado</p></div><span class="chip">' +
    outcomes[x.result.status] + '</span></div><p>' + escape(p.brief.action) + '</p><div class="experiment-results">' +
    arm('Control A', x.a) + arm('Variante B', x.b) + '</div><p>' + (ci ? 'Diferencia B − A ' + points(x.result.delta) +
      ' · IC 95 % [' + points(ci[0]) + ', ' + points(ci[1]) + ']' : 'Añade tráfico para calcular la diferencia.') +
    '</p><progress aria-label="Muestra por grupo" value="' + x.a.n + '" max="' + x.sample + '"></progress><p>' +
    number.format(x.a.n) + ' de ' + number.format(x.sample) + ' ' + units + ' por grupo. ' +
    (p.status === 'running' ? 'El resultado se decide al alcanzar la muestra prevista.' : 'Prueba simulada completada.') +
    '</p>' + (p.status === 'running' ? '<div class="card-actions">' + action(p, 'simulate', 'Simular 400 ' + units + ' por grupo', 'primary') + '</div>' : '') + '</article>';
}

function render() {
  const title = scope === 'demo' ? 'Datos de ejemplo' : 'Mis datos';
  el('scope-name').textContent = title;
  for (const button of document.querySelectorAll('[data-scope]')) button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
  const { start, end } = snapshot.range;
  const range = end ? asDate(start) + ' – ' + asDate(end) : 'Sin datos en este conjunto';
  el('range').textContent = range;
  el('campaign-caption').textContent = range + ' · ' + (el('channel').value || 'Todos los canales');
  el('export-link').href = '/api/export?scope=' + scope;
  el('export-link').hidden = !snapshot.rowCount;
  renderMetrics();
  fill('campaign-preview', campaignTable(snapshot.campaigns.slice(0, 4)));
  fill('campaign-table', campaignTable(snapshot.campaigns));
  const queue = snapshot.proposals.filter(p => p.status === 'draft').sort((a, b) => b.end.localeCompare(a.end) ||
    Number(b.priority === 'Alta') - Number(a.priority === 'Alta') || Math.abs(b.change) - Math.abs(a.change));
  el('queue-count').textContent = queue.length;
  el('queue-count').hidden = !queue.length;
  el('summary-count').textContent = queue.length;
  fill('queue-preview', queue.slice(0, 3).map(p => '<a class="queue-item" href="#automatizacion/' + p.id +
    '"><span class="chip ' + (p.priority === 'Alta' ? 'hot' : '') + '">' + p.priority + '</span><strong>' +
    escape(p.title) + '</strong><small>' + escape(p.campaign) + ' · ' + signed(p.change, percent.format) +
    '</small></a>').join('') || empty('No hay propuestas pendientes.'));
  el('schedule-note').textContent = snapshot.schedule.enabled
    ? (browserMode ? 'Activo mientras la demo está abierta.' : 'Activo mientras el servidor está abierto.') +
      ' Próxima ejecución ' + time.format(snapshot.schedule.nextAt) + '.'
    : 'Pausado. El análisis manual sigue disponible.';
  el('schedule-button').textContent = snapshot.schedule.enabled ? 'Pausar análisis automático' : 'Activar cada 15 min';
  el('model-note').textContent = browserMode ? 'Demo local al navegador · detección y borradores por reglas.' :
    snapshot.model ? 'Ollama configurado · ' + snapshot.model + ' · respaldo por reglas' :
    'Detección y propuestas por reglas. Ollama se puede activar en el servidor.';
  fill('proposals', [...queue, ...snapshot.proposals.filter(p => p.status !== 'draft')].map(proposalCard).join('') ||
    '<article class="panel">' + empty('Ejecuta un análisis para generar propuestas a partir de las campañas.') + '</article>');
  fill('experiments', snapshot.proposals.filter(p => p.experiment).map(experimentCard).join('') ||
    '<article class="panel">' + empty('Aprueba una propuesta en Automatización para crear tu primera prueba A/B.') + '</article>');
  fill('activity', snapshot.activity.map(item => '<div class="activity-row"><time datetime="' + escape(item.ts) +
    '">' + time.format(new Date(item.ts)) + '</time><span>' + escape(item.message) + '</span></div>').join('') ||
    empty('Todavía no hay actividad.'));
  drawChart();
}

const chart = el('chart');
chart.setAttribute('aria-describedby', 'chart-description');
const ctx = chart.getContext('2d');
const seriesLabels = { revenue: 'Ingresos', spend: 'Gasto', conversions: 'Conversiones', ctr: 'CTR' };
const colors = ['#db5e39', '#6277aa'];
let chartHit;

function drawChart() {
  if (!snapshot || el('view-resumen').hidden) return;
  const { width, height } = chart.getBoundingClientRect();
  if (width < 60 || height < 60) return;
  const scale = Math.min(2.5, window.devicePixelRatio || 1);
  chart.width = Math.round(width * scale);
  chart.height = Math.round(height * scale);
  ctx.scale(scale, scale);
  ctx.font = '12px "Segoe UI", sans-serif';
  const kind = el('chart-metric').value;
  const keys = kind === 'revenue' ? ['revenue', 'spend'] : [kind];
  const format = kind === 'revenue' ? value => money.format(value / 100) :
    kind === 'ctr' ? asRate : number.format;
  const rows = snapshot.trend;
  const max = Math.max(0, ...rows.flatMap(row => keys.map(key => row.metrics?.[key] ?? 0)));
  fill('chart-legend', keys.map((key, index) =>
    '<span class="legend-item' + (index ? ' secondary-series' : '') + '">' + seriesLabels[key] + '</span>').join(''));
  el('chart-description').textContent = rows.map(row => asDate(row.date) + ' ' + keys.map(key =>
    seriesLabels[key] + ' ' + (row.metrics?.[key] == null ? 'sin datos' : format(row.metrics[key]))).join(', ')).join('. ');
  el('chart-tip').hidden = true;
  if (!rows.some(row => row.metrics)) {
    chartHit = null;
    ctx.fillStyle = '#59677a';
    ctx.textAlign = 'center';
    ctx.fillText('Importa campañas para ver la tendencia.', width / 2, height / 2);
    return;
  }
  const unit = 10 ** Math.floor(Math.log10(max / 4 || 1));
  const step = Math.ceil(max / 4 / unit) * unit || 1;
  const axisMax = step * 4;
  const left = width < 380 ? 54 : 67;
  const right = width - 14;
  const top = 14;
  const bottom = height - 30;
  const x = i => left + (right - left) * i / Math.max(rows.length - 1, 1);
  const y = value => bottom - (bottom - top) * value / axisMax;

  ctx.fillStyle = '#59677a';
  ctx.strokeStyle = '#e6eaf1';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const line = y(axisMax * i / 4);
    ctx.beginPath(); ctx.moveTo(left, line); ctx.lineTo(right, line); ctx.stroke();
    ctx.fillText(format(axisMax * i / 4), left - 8, line + 4);
  }
  const labelCount = width < 470 ? 4 : 6;
  const ticks = new Set(Array.from({ length: labelCount }, (_, i) => Math.round(i * (rows.length - 1) / (labelCount - 1))));
  for (const i of ticks) {
    ctx.textAlign = i === rows.length - 1 ? 'right' : i === 0 ? 'left' : 'center';
    ctx.fillText(asDate(rows[i].date), x(i), height - 8);
  }

  keys.forEach((key, j) => {
    const spans = [];
    let points = [];
    rows.forEach((row, i) => {
      const value = row.metrics?.[key];
      if (value != null) points.push([x(i), y(value)]);
      else if (points.length) { spans.push(points); points = []; }
    });
    if (points.length) spans.push(points);
    for (const span of spans) {
      if (!j && span.length > 1) {
        const fade = ctx.createLinearGradient(0, top, 0, bottom);
        fade.addColorStop(0, '#fc784e3f'); fade.addColorStop(1, '#fc784e00');
        ctx.fillStyle = fade;
        ctx.beginPath();
        ctx.moveTo(span[0][0], bottom);
        for (const point of span) ctx.lineTo(...point);
        ctx.lineTo(span.at(-1)[0], bottom); ctx.closePath(); ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(...span[0]);
      for (const point of span.slice(1)) ctx.lineTo(...point);
      ctx.strokeStyle = colors[j]; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
      if (span.length === 1) {
        ctx.beginPath(); ctx.arc(...span[0], 3, 0, Math.PI * 2);
        ctx.fillStyle = colors[j]; ctx.fill();
      }
    }
  });
  chartHit = { left, right, rows, keys, format };
}

chart.addEventListener('pointermove', event => {
  if (!chartHit) return;
  const { left, right, rows, keys, format } = chartHit;
  const i = Math.max(0, Math.min(rows.length - 1, Math.round((event.offsetX - left) / (right - left) * (rows.length - 1))));
  const row = rows[i];
  el('chart-tip').textContent = asDate(row.date) + ' · ' + keys.map(key => seriesLabels[key] + ' ' +
    (row.metrics?.[key] == null ? '—' : format(row.metrics[key]))).join(' · ');
  el('chart-tip').hidden = false;
});
chart.addEventListener('pointerleave', () => { el('chart-tip').hidden = true; });
new ResizeObserver(drawChart).observe(chart.parentElement);

async function mutate(button, operation) {
  if (mutating) return;
  mutating = true;
  button.disabled = true;
  try {
    await operation();
    await refresh();
  } catch (error) { toast(error.message); }
  finally { mutating = false; button.disabled = false; }
}

el('scan-button').addEventListener('click', event => {
  const button = event.currentTarget;
  mutate(button, async () => {
    const result = await request('/api/scan', { method: 'POST' });
    toast(result.detected + ' señales detectadas · ' + result.added + ' propuestas nuevas.');
  });
});
el('schedule-button').addEventListener('click', event => {
  if (!snapshot) return;
  mutate(event.currentTarget, async () => {
    const { enabled } = await request('/api/schedule', { method: 'POST', body: JSON.stringify({ enabled: !snapshot.schedule.enabled }) });
    toast(enabled ? 'Análisis automático activado.' : 'Análisis automático pausado.');
  });
});
el('content').addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { id, action: operation } = button.dataset;
  mutate(button, async () => {
    await request('/api/proposals/' + id + '/' + operation, { method: 'POST' });
    if (operation === 'approve') toast('Experimento creado. Puedes simular tráfico en Experimentos.');
    if (operation === 'dismiss') toast('Propuesta descartada.');
    if (operation === 'simulate') toast('Tráfico sintético incorporado.');
  });
});

const dialog = el('data-dialog');
for (const id of ['data-button', 'scope-button']) {
  el(id).addEventListener('click', () => { el('form-error').textContent = ''; dialog.showModal(); });
}

if (browserMode) {
  for (const id of ['sample-link', 'export-link']) {
    el(id).addEventListener('click', async event => {
      event.preventDefault();
      const sample = id === 'sample-link';
      try {
        const csv = await (await getBrowserStore()).exportCsv(sample ? 'sample' : scope);
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = sample ? 'campanas-ejemplo.csv' : 'campaign-loop.csv';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { toast(error.message); }
    });
  }
}

function selectScope(dataset) {
  scope = dataset;
  localStorage.setItem('campaign-loop-scope', scope);
  snapshot = undefined;
}

for (const button of document.querySelectorAll('[data-scope]')) {
  button.addEventListener('click', async () => {
    selectScope(button.dataset.scope);
    dialog.close();
    await refresh().catch(error => toast(error.message));
  });
}

el('import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = el('csv').files[0];
  const button = event.submitter;
  if (!file || button.disabled) return;
  button.disabled = true;
  el('form-error').textContent = '';
  try {
    if (file.size > 2_000_000) throw new Error('El archivo supera el límite de 2 MB.');
    const result = await request('/api/import', { method: 'POST', dataset: 'workspace', body: await file.text() });
    selectScope('workspace');
    await refresh();
    dialog.close();
    event.target.reset();
    toast(number.format(result.rows) + ' filas importadas en Mis datos.');
  } catch (error) { el('form-error').textContent = error.message; }
  finally { button.disabled = false; }
});

for (const id of ['days', 'channel']) el(id).addEventListener('change', () => refresh().catch(error => toast(error.message)));
el('chart-metric').addEventListener('change', drawChart);
window.addEventListener('hashchange', renderRoute);
renderRoute();
await refresh().catch(error => toast(error.message));
renderRoute();
setInterval(() => {
  if (!mutating && !document.hidden) refresh().catch(() => {});
}, 25000);
if (browserMode) setInterval(() => {
  if (!mutating) getBrowserStore().then(store => store.runDueScans()).catch(() => {});
}, 5000);
