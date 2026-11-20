export const channels = ['Meta Ads', 'Google Ads', 'Email'];
export const cadence = 15 * 60 * 1000;
export const dayMs = 86_400_000;
export const dayAt = (iso, offset) => new Date(Date.parse(iso) + offset * dayMs).toISOString().slice(0, 10);
export const csvFields = ['date', 'campaign', 'channel', 'impressions', 'clicks', 'conversions', 'spend_eur', 'revenue_eur'];

export function parseCampaignCsv(csv) {
  const records = [];
  let record = [], field = '', quoted = false, closed = false;
  for (const char of csv.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')) {
    if (quoted) {
      if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"' && closed) {
      field += '"'; quoted = true; closed = false;
    } else if (char === '"' && !field) {
      quoted = true;
    } else if (char === ',' || char === '\n') {
      record.push(field.trim());
      field = ''; closed = false;
      if (char === '\n') { if (record.some(Boolean)) records.push(record); record = []; }
    } else {
      if (closed || char === '"') throw new Error('Encontré comillas mal cerradas en el CSV.');
      field += char;
    }
  }
  if (quoted) throw new Error('Encontré comillas mal cerradas en el CSV.');
  record.push(field.trim());
  if (record.some(Boolean)) records.push(record);
  if (records.shift()?.join(',') !== csvFields.join(',')) throw new Error('Usa las columnas y el orden del CSV de ejemplo.');
  if (!records.length || records.length > 10000) throw new Error('El CSV debe contener entre 1 y 10.000 filas de datos.');
  const keys = new Set();
  return records.map((row, index) => {
    const [date, campaign, channel, ...numbers] = row;
    const [impressions, clicks, conversions, spend, revenue] = numbers.map(Number);
    const key = JSON.stringify([date, channel, campaign]);
    const dateNumber = Date.parse(date);
    if (row.length !== csvFields.length || !/^20\d{2}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(dateNumber) || new Date(dateNumber).toISOString().slice(0, 10) !== date ||
        !campaign || campaign.length > 90 || /[\r\n\t]/.test(campaign) || !channels.includes(channel) ||
        !numbers.every((item, i) => (i < 3 ? /^\d{1,9}$/ : /^\d{1,9}(?:\.\d{1,2})?$/).test(item)) ||
        clicks > impressions || conversions > clicks || keys.has(key)) {
      throw new Error('Revisa la fecha, el canal, las métricas o la clave duplicada en la fila ' + (index + 2) + '.');
    }
    keys.add(key);
    return { date, campaign, channel, impressions, clicks, conversions, spend: Math.round(spend * 100), revenue: Math.round(revenue * 100) };
  });
}

export function encodeCampaignCsv(rows) {
  const escape = value => '"' + String(value).replaceAll('"', '""') + '"';
  return [csvFields.join(','), ...rows.map(row => {
    const name = /^[=+\-@]/.test(row.campaign) ? '\'' + row.campaign : row.campaign;
    return [row.date, escape(name), escape(row.channel), row.impressions, row.clicks, row.conversions,
      (row.spend / 100).toFixed(2), (row.revenue / 100).toFixed(2)].join(',');
  })].join('\r\n');
}

export function totals(rows) {
  const result = { impressions: 0, clicks: 0, conversions: 0, spend: 0, revenue: 0 };
  for (const row of rows) for (const field of Object.keys(result)) result[field] += row[field];
  return { ...result, ctr: result.impressions ? result.clicks / result.impressions : null,
    cvr: result.clicks ? result.conversions / result.clicks : null,
    cpa: result.conversions ? result.spend / result.conversions : null,
    roas: result.spend ? result.revenue / result.spend : null };
}

export function timeWindow(rows, days) {
  const end = rows.at(-1)?.date;
  if (!end) return { end, start: null, recent: [], previous: [], trend: [] };
  const start = dayAt(end, 1 - days);
  const earlier = dayAt(start, -days);
  const recent = rows.filter(row => row.date >= start);
  const previous = rows.filter(row => row.date >= earlier && row.date < start);
  const byDay = new Map();
  for (const row of recent) {
    if (!byDay.has(row.date)) byDay.set(row.date, []);
    byDay.get(row.date).push(row);
  }
  return { end, start, recent, previous,
    trend: Array.from({ length: days }, (_, i) => {
      const date = dayAt(start, i);
      return { date, metrics: byDay.has(date) ? totals(byDay.get(date)) : null };
    }) };
}

const signals = {
  cpa: { title: 'Coste de captación al alza', priority: 'Alta',
    hypothesis: 'Una propuesta más concreta puede atraer visitas con mayor intención de compra.',
    action: 'Probar una variante que explique el beneficio antes del CTA. Mantener la audiencia y el presupuesto.',
    variant: 'Encuentra la opción que encaje contigo. Compara los detalles y elige con calma. CTA: Ver las opciones.' },
  ctr: { title: 'Caída del interés por el anuncio', priority: 'Alta',
    hypothesis: 'Un primer mensaje más relevante puede mejorar la respuesta sin aumentar el presupuesto.',
    action: 'Cambiar el texto inicial y mantener el CTA, la audiencia y el presupuesto.',
    variant: '¿Hace tiempo que no nos visitas? Vuelve a explorar la selección y guarda lo que te interese.' },
  cvr: { title: 'Descenso de conversión', priority: 'Media',
    hypothesis: 'Alinear la página de destino con la promesa del anuncio puede mejorar la conversión.',
    action: 'Comparar la página actual con una variante que explica la oferta antes de mostrar el catálogo.',
    variant: 'Encuentra lo que venías a buscar. Revisa las características antes de elegir. CTA: Explorar la selección.' },
};

export async function detect(rows) {
  const { end, recent, previous } = timeWindow(rows, 7);
  const groups = new Map();
  for (const row of recent) groups.set(JSON.stringify([row.channel, row.campaign]), row);
  const findings = [];
  for (const [key, { campaign, channel }] of groups) {
    const matches = row => row.campaign === campaign && row.channel === channel;
    const recentRows = recent.filter(matches);
    const previousRows = previous.filter(matches);
    if (recentRows.length !== 7 || previousRows.length !== 7) continue;
    const current = totals(recentRows);
    const baseline = totals(previousRows);
    const rules = [
      { metric: 'cpa', threshold: 0.28, direction: 1, qualifies: current.conversions >= 15 && baseline.conversions >= 15 && current.spend >= 10000 },
      { metric: 'ctr', threshold: 0.22, direction: -1, qualifies: Math.min(current.impressions, baseline.impressions) >= 3000 && baseline.clicks >= 50 },
      { metric: 'cvr', threshold: 0.25, direction: -1, qualifies: Math.min(current.clicks, baseline.clicks) >= 250 && baseline.conversions >= 15 && channel !== 'Email' },
    ];
    const eligible = rules.filter(rule => rule.qualifies && baseline[rule.metric] > 0 &&
      ((current[rule.metric] / baseline[rule.metric]) - 1) * rule.direction >= rule.threshold);
    if (!eligible.length) continue;
    const { metric } = eligible[0];
    const bytes = new TextEncoder().encode(JSON.stringify([key, metric, recentRows, previousRows]));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const id = Array.from(new Uint8Array(digest, 0, 10), value => value.toString(16).padStart(2, '0')).join('');
    findings.push({ id, campaign, channel, end, metric, before: baseline[metric], after: current[metric],
      change: current[metric] / baseline[metric] - 1, baseRate: current[metric === 'ctr' ? 'ctr' : 'cvr'] ?? 0, ...signals[metric] });
  }
  return findings.sort((a, b) => Number(b.priority === 'Alta') - Number(a.priority === 'Alta') ||
    Math.abs(b.change) - Math.abs(a.change) || a.id.localeCompare(b.id));
}

export function demoRows(end = new Date().toISOString().slice(0, 10)) {
  const campaigns = [
    ['Prospección · colección de otoño', 'Meta Ads', 14900, .0158, .047, 132, .80, .93, 1.10],
    ['Retargeting · catálogo', 'Meta Ads', 8600, .026, .076, 94, .66, 1.10, 1],
    ['Búsqueda · marca', 'Google Ads', 7200, .035, .092, 85, 1.07, 1.04, 1],
    ['Shopping · chaquetas', 'Google Ads', 9800, .018, .069, 105, 1.02, .61, .89],
    ['Bienvenida · comunidad', 'Email', 4600, .047, .071, 8, 1.05, 1.14, 1],
    ['Reactivación · clientes', 'Email', 5100, .036, .057, 9, .66, 1.02, 1],
  ];
  return Array.from({ length: 56 }, (_, i) => campaigns.map(([
    campaign, channel, reach, ctr, rate, cost, ctrFactor, rateFactor, costFactor,
  ], j) => {
    const fluctuation = 1 + Math.sin(i * .61 + j * .5) * .20 + Math.cos(i * 1.04 + j) * .11 + i * .0045;
    const recent = i >= 49;
    const impressions = Math.round(reach * fluctuation);
    const clicks = Math.round(impressions * ctr * (recent ? ctrFactor : 1));
    const conversions = Math.round(clicks * rate * (recent ? rateFactor : 1) * (.99 + .11 * Math.sin(i * .88 + j)));
    const spend = Math.round(cost * 100 * fluctuation * (recent ? costFactor : 1));
    const revenue = Math.round(conversions * (5200 + j * 610 + 400 * Math.cos(i * .73 + j)));
    return { date: dayAt(end, i - 55), campaign, channel, impressions, clicks, conversions, spend, revenue };
  })).flat().sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel) || a.campaign.localeCompare(b.campaign, 'en'));
}

function wilson(successes, total) {
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + z ** 2 / total;
  const centre = (p + z ** 2 / (2 * total)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / total + z ** 2 / (4 * total ** 2)) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function experimentResult(a, b, sample) {
  if (!a.n || !b.n) return { status: 'collecting', delta: null, interval: null };
  const pA = a.x / a.n;
  const pB = b.x / b.n;
  const [aLo, aHi] = wilson(a.x, a.n);
  const [bLo, bHi] = wilson(b.x, b.n);
  const delta = pB - pA;
  const interval = [delta - Math.hypot(pB - bLo, aHi - pA), delta + Math.hypot(bHi - pB, pA - aLo)];
  const status = Math.min(a.n, b.n) < sample ? 'collecting' :
    interval[0] > 0 ? 'variant' : interval[1] < 0 ? 'control' : 'inconclusive';
  return { status, delta, interval };
}

export function syntheticConversions(id, arm, batch, n, probability) {
  let state = 2166136261;
  for (const char of id + ':' + arm + ':' + batch) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  if (!state) state = 1;
  let conversions = 0;
  for (let i = 0; i < n; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    if ((state >>> 0) / 4294967296 < probability) conversions++;
  }
  return conversions;
}

export function summarize(all, days, channel) {
  const window = timeWindow(all, days);
  const filter = rows => channel ? rows.filter(row => row.channel === channel) : rows;
  const period = filter(window.recent);
  const previous = filter(window.previous);
  const groups = new Map();
  const filteredDays = new Map();
  for (const row of period) {
    const key = JSON.stringify([row.channel, row.campaign]);
    if (!groups.has(key)) groups.set(key, []);
    if (!filteredDays.has(row.date)) filteredDays.set(row.date, []);
    groups.get(key).push(row);
    filteredDays.get(row.date).push(row);
  }
  const campaigns = [...groups.values()].map(rows => ({ name: rows[0].campaign, channel: rows[0].channel, ...totals(rows) }))
    .sort((a, b) => b.revenue - a.revenue);
  return {
    range: { start: window.start, end: window.end },
    metrics: totals(period), previous: totals(previous),
    baseline: [period, previous].every(rows => new Set(rows.map(row => row.date)).size === days),
    trend: window.trend.map(({ date }) => ({ date, metrics: filteredDays.has(date) ? totals(filteredDays.get(date)) : null })),
    campaigns, rowCount: all.length,
  };
}

export function describeExperiment(experiment) {
  return experiment && { ...experiment, result: experimentResult(experiment.a, experiment.b, experiment.sample) };
}

export function advanceProposal(proposal, action) {
  const { id, status, campaign, metric } = proposal;
  if (status === 'draft' && action === 'approve') {
    return { status: 'running', experiment: { a: { n: 0, x: 0 }, b: { n: 0, x: 0 }, sample: 2000, batch: 0 },
      message: 'Experimento A/B simulado aprobado · ' + campaign };
  }
  if (status === 'draft' && action === 'dismiss') {
    return { status: 'dismissed', experiment: null, message: 'Propuesta descartada · ' + campaign };
  }
  if (status !== 'running' || action !== 'simulate') throw new Error('La propuesta ya no admite esa acción.');
  const { sample, batch, a, b } = proposal.experiment;
  const n = Math.min(400, sample - a.n);
  const base = Math.min(0.85, Math.max(0.001, metric === 'ctr' ? proposal.after : proposal.baseRate));
  const append = (arm, data, p) => ({ n: data.n + n, x: data.x + syntheticConversions(id, arm, batch, n, Math.min(.99, p)) });
  const experiment = { a: append('a', a, base), b: append('b', b, base * (metric === 'ctr' ? .94 : 1.38)), sample, batch: batch + 1 };
  const outcome = experimentResult(experiment.a, experiment.b, sample);
  const complete = outcome.status !== 'collecting';
  return { status: complete ? 'complete' : 'running', experiment,
    message: (complete ? 'Experimento completado' : 'Tráfico sintético añadido') + ' · ' + experiment.a.n +
      (metric === 'ctr' ? ' impresiones' : ' visitas') + ' por variante · ' + campaign };
}
