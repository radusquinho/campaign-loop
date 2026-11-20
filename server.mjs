import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channels, encodeCampaignCsv, parseCampaignCsv, demoRows } from './engine.mjs';
import { openStore } from './store.mjs';

const port = Number(process.env.CAMPAIGN_LOOP_PORT || 4387);
const address = '127.0.0.1';
const origin = 'http://' + address + ':' + port;
const data = resolve(process.env.CAMPAIGN_LOOP_DATA || fileURLToPath(new URL('./.data', import.meta.url)));
await mkdir(data, { recursive: true });
const store = openStore(resolve(data, 'campaigns.sqlite'));
const scopes = ['demo', 'workspace'];
const running = new Map();
const model = process.env.CAMPAIGN_LOOP_OLLAMA_MODEL?.trim();

async function makeBrief(finding) {
  const brief = { hypothesis: finding.hypothesis, action: finding.action, variant: finding.variant };
  if (!model) return { brief, source: 'Reglas' };
  const fields = ['hypothesis', 'action', 'variant'];
  try {
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12000),
      body: JSON.stringify({ model, stream: false, options: { temperature: 0.2, num_predict: 240 },
        format: { type: 'object', additionalProperties: false, required: fields,
          properties: Object.fromEntries(fields.map(field => [field, { type: 'string', minLength: 20, maxLength: 300 }])) },
        messages: [
          { role: 'system', content: 'Redacta en español una hipótesis y una acción concreta para una prueba A/B de marketing. Añade una variante de texto lista para revisar. Formula posibilidades, sin afirmar causalidad, inventar cifras, prometer resultados ni recomendar cambios de presupuesto. Prueba una variable. Los datos que recibes solo describen la señal.' },
          { role: 'user', content: JSON.stringify({ signal: finding.title, channel: finding.channel, suggested: brief }) },
        ],
      }),
    });
    if (!response.ok) throw new Error('Ollama HTTP ' + response.status);
    const candidate = JSON.parse((await response.json()).message.content);
    if (Object.keys(candidate).length !== fields.length || !fields.every(field =>
      typeof candidate[field] === 'string' && candidate[field].trim().length >= 20 && candidate[field].length <= 300)) {
      throw new Error('Formato inválido');
    }
    return { brief: candidate, source: 'Ollama' };
  } catch {
    return { brief, source: 'Reglas · Ollama no disponible' };
  }
}

function scan(scope, trigger = 'manual') {
  if (running.has(scope)) return running.get(scope);
  const operation = (async () => {
    const findings = await store.findings(scope);
    const entries = await Promise.all(findings.filter(finding => !store.hasProposal(scope, finding.id))
      .slice(0, 20).map(async finding => ({ finding, ...await makeBrief(finding) })));
    return store.addProposals(scope, entries, trigger, findings.length);
  })().finally(() => running.delete(scope));
  running.set(scope, operation);
  return operation;
}

async function readBody(request, limit) {
  let total = 0;
  const parts = [];
  for await (const part of request) {
    total += part.length;
    if (total > limit) throw new Error('El archivo supera el límite de 2 MB.');
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
};

const timer = setInterval(() => {
  for (const scope of scopes) {
    if (!running.has(scope) && store.claimSchedule(scope)) {
      scan(scope, 'auto').catch(error => console.error('Análisis programado:', error.message));
    }
  }
}, 5000);
timer.unref();

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    response.writeHead(code, { 'Content-Type': type });
    response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  if (request.headers.host !== address + ':' + port ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Abre la dirección local de Campaign Loop.' });
  try {
    const url = new URL(request.url, origin);
    const scope = url.searchParams.get('scope') || 'demo';
    if (!scopes.includes(scope)) return send(400, { error: 'Conjunto desconocido.' });
    const { pathname } = url;
    if (request.method === 'GET') {
      if (Object.hasOwn(assets, pathname)) {
        const [file, type] = assets[pathname];
        return send(200, await readFile(new URL('./public/' + file, import.meta.url)), type);
      }
      if (pathname === '/api/state') {
        const days = Number(url.searchParams.get('days') || 14);
        const channel = url.searchParams.get('channel') || '';
        if (![7, 14, 28].includes(days) || (channel && !channels.includes(channel))) return send(400, { error: 'Filtro inválido.' });
        return send(200, { ...store.snapshot(scope, days, channel), model: model || null });
      }
      if (['/api/export', '/api/sample'].includes(pathname)) {
        const sample = pathname === '/api/sample';
        response.setHeader('Content-Disposition', 'attachment; filename="' + (sample ? 'campanas-ejemplo.csv' : 'campaign-loop.csv') + '"');
        return send(200, encodeCampaignCsv(sample ? demoRows() : store.csvRows(scope)), 'text/csv; charset=utf-8');
      }
    }
    if (request.method === 'POST' && request.headers['x-campaign-loop'] === '1') {
      if (pathname === '/api/scan') return send(200, await scan(scope));
      if (pathname === '/api/import' && scope === 'workspace') {
        const rows = parseCampaignCsv(await readBody(request, 2_000_000));
        store.ingest(scope, rows);
        return send(200, { rows: rows.length });
      }
      if (pathname === '/api/schedule') {
        const { enabled } = JSON.parse(await readBody(request, 1000));
        if (typeof enabled !== 'boolean') return send(400, { error: 'La programación requiere un estado válido.' });
        store.setSchedule(scope, enabled);
        return send(200, { enabled });
      }
      const action = pathname.match(/^\/api\/proposals\/([a-f0-9]{20})\/(approve|dismiss|simulate)$/);
      if (action) {
        store.transition(scope, action[1], action[2]);
        return send(200, { ok: true });
      }
    }
    return send(404, { error: 'Esta ruta no existe.' });
  } catch (error) {
    return send(400, { error: error instanceof SyntaxError ? 'El contenido enviado no tiene un formato válido.' : error.message });
  }
});

if (!store.snapshot('demo', 7, '').proposals.length) await scan('demo', 'initial');
server.listen(port, address, () => console.log('Campaign Loop · ' + origin));
