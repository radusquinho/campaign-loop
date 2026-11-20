import { advanceProposal, cadence, demoRows, describeExperiment, detect, encodeCampaignCsv, parseCampaignCsv, summarize } from './engine.mjs';

const defaultSchedule = () => ({ enabled: 0, nextAt: null });
const newDataset = () => ({ rows: [], proposals: [], activity: [], schedule: defaultSchedule() });
const scopes = ['demo', 'workspace'];
const rowKey = row => JSON.stringify([row.date, row.channel, row.campaign]);
const compare = (a, b) => a > b ? 1 : a < b ? -1 : 0;
const sortRows = rows => rows.sort((a, b) => compare(a.date, b.date) || compare(a.channel, b.channel) || compare(a.campaign, b.campaign));
function log(dataset, type, message) {
  dataset.activity.unshift({ ts: new Date().toISOString(), type, message });
  dataset.activity = dataset.activity.slice(0, 80);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('campaign-loop-demo', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('datasets');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

export async function createBrowserStore() {
  const db = await openDatabase();
  function withDataset(scope, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('datasets', mode);
      const datasets = transaction.objectStore('datasets');
      const request = datasets.get(scope);
      let result;
      let failure;
      request.onsuccess = () => {
        try {
          const dataset = request.result || newDataset();
          result = operation(dataset);
          if (mode === 'readwrite') datasets.put(dataset, scope);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure || transaction.error || new Error('No se pudo guardar el cambio en el navegador.'));
    });
  }
  const read = (scope, operation) => withDataset(scope, 'readonly', operation);
  const update = (scope, operation) => withDataset(scope, 'readwrite', operation);
  const scanning = new Map();

  function scan(scope, trigger) {
    if (scanning.has(scope)) return scanning.get(scope);
    const pending = (async () => {
      const rows = await read(scope, dataset => dataset.rows);
      const findings = await detect(rows);
      return update(scope, dataset => {
        if (trigger === 'initial' && dataset.proposals.length) return;
        const known = new Set(dataset.proposals.map(proposal => proposal.id));
        const added = findings.filter(finding => !known.has(finding.id)).slice(0, 20).map(finding => ({
          ...finding, status: 'draft', source: 'Reglas', experiment: null,
          brief: { hypothesis: finding.hypothesis, action: finding.action, variant: finding.variant },
        }));
        dataset.proposals.unshift(...added);
        const labels = { initial: 'Análisis inicial', manual: 'Análisis manual', auto: 'Análisis programado' };
        log(dataset, 'scan', labels[trigger] + ' · ' + findings.length + ' señales detectadas · ' + added.length + ' propuestas nuevas.');
        return { detected: findings.length, added: added.length };
      });
    })().finally(() => scanning.delete(scope));
    scanning.set(scope, pending);
    return pending;
  }

  const initial = await update('demo', dataset => {
    if (!dataset.rows.length) {
      dataset.rows = sortRows(demoRows());
      log(dataset, 'import', dataset.rows.length + ' filas de ejemplo incorporadas.');
    }
    return !dataset.proposals.length;
  });
  if (initial) await scan('demo', 'initial');

  async function runDueScans() {
    for (const scope of scopes) {
      if (scanning.has(scope)) continue;
      const due = await read(scope, ({ schedule }) => schedule.enabled && schedule.nextAt <= Date.now());
      if (!due) continue;
      const claimed = await update(scope, ({ schedule }) => {
        if (!schedule.enabled || schedule.nextAt > Date.now()) return false;
        schedule.nextAt = Date.now() + cadence;
        return true;
      });
      if (claimed) await scan(scope, 'auto');
    }
  }

  return {
    runDueScans,
    async request(path, { body, dataset: scope, filters }) {
      if (path === '/api/state') return read(scope, dataset => ({
        ...summarize(dataset.rows, Number(filters.days), filters.channel),
        activity: dataset.activity, schedule: dataset.schedule, model: null,
        proposals: dataset.proposals.map(proposal => ({ ...proposal, experiment: describeExperiment(proposal.experiment) })),
      }));
      if (path === '/api/scan') return scan(scope, 'manual');
      if (path === '/api/import' && scope === 'workspace') {
        const imported = parseCampaignCsv(body);
        return update(scope, dataset => {
          const keyed = new Map(dataset.rows.map(row => [rowKey(row), row]));
          for (const row of imported) keyed.set(rowKey(row), row);
          dataset.rows = sortRows([...keyed.values()]);
          log(dataset, 'import', imported.length + ' filas agregadas incorporadas. Las claves existentes se actualizaron.');
          return { rows: imported.length };
        });
      }
      if (path === '/api/schedule') {
        const { enabled } = JSON.parse(body);
        return update(scope, dataset => {
          dataset.schedule = enabled ? { enabled: 1, nextAt: Date.now() + cadence } : defaultSchedule();
          log(dataset, 'schedule', enabled ? 'Análisis cada 15 minutos activado.' : 'Análisis programado pausado.');
          return { enabled };
        });
      }
      const match = path.match(/^\/api\/proposals\/([a-f0-9]{20})\/(approve|dismiss|simulate)$/);
      if (!match) throw new Error('Esta operación no está disponible.');
      const [, id, action] = match;
      return update(scope, dataset => {
        const proposal = dataset.proposals.find(item => item.id === id);
        if (!proposal) throw new Error('La propuesta ya no está disponible.');
        const { status, experiment, message } = advanceProposal(proposal, action);
        Object.assign(proposal, { status, experiment });
        log(dataset, action, message);
        return { ok: true };
      });
    },
    async exportCsv(scope) {
      return scope === 'sample' ? encodeCampaignCsv(demoRows()) : read(scope, dataset => encodeCampaignCsv(dataset.rows));
    },
  };
}
