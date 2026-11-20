import { DatabaseSync } from 'node:sqlite';
import { advanceProposal, cadence, demoRows, describeExperiment, detect, summarize } from './engine.mjs';

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS daily (
      scope TEXT NOT NULL, date TEXT NOT NULL, campaign TEXT NOT NULL, channel TEXT NOT NULL,
      impressions INTEGER NOT NULL, clicks INTEGER NOT NULL, conversions INTEGER NOT NULL,
      spend INTEGER NOT NULL, revenue INTEGER NOT NULL,
      PRIMARY KEY (scope, date, channel, campaign)
    );
    CREATE TABLE IF NOT EXISTS proposals (
      scope TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
      finding TEXT NOT NULL, brief TEXT NOT NULL, source TEXT NOT NULL, experiment TEXT,
      PRIMARY KEY (scope, id)
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedule (
      scope TEXT PRIMARY KEY, enabled INTEGER NOT NULL, next_at INTEGER
    );
  `);
  const audit = db.prepare('INSERT INTO activity (scope, ts, type, message) VALUES (?, ?, ?, ?)');
  const log = (scope, type, message) => audit.run(scope, new Date().toISOString(), type, message);
  const writeRow = db.prepare(`INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, date, channel, campaign) DO UPDATE SET impressions=excluded.impressions,
    clicks=excluded.clicks, conversions=excluded.conversions, spend=excluded.spend, revenue=excluded.revenue`);
  const selectRows = db.prepare('SELECT date, campaign, channel, impressions, clicks, conversions, spend, revenue FROM daily WHERE scope = ? ORDER BY date, channel, campaign');
  const selectAll = db.prepare('SELECT * FROM proposals WHERE scope = ? ORDER BY rowid DESC');
  const selectOne = db.prepare('SELECT * FROM proposals WHERE scope = ? AND id = ?');
  const listActivity = db.prepare('SELECT ts, type, message FROM activity WHERE scope = ? ORDER BY id DESC LIMIT 80');
  const readSchedule = db.prepare('SELECT enabled, next_at AS nextAt FROM schedule WHERE scope = ?');
  const writeSchedule = db.prepare(`INSERT INTO schedule VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled, next_at=excluded.next_at`);

  function transact(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function ingest(scope, rows) {
    return transact(() => {
      for (const row of rows) {
        writeRow.run(scope, row.date, row.campaign, row.channel, row.impressions, row.clicks, row.conversions, row.spend, row.revenue);
      }
      log(scope, 'import', rows.length + ' filas agregadas incorporadas. Las claves existentes se actualizaron.');
    });
  }

  if (!selectRows.get('demo')) ingest('demo', demoRows());

  function addProposals(scope, entries, trigger, count) {
    const insert = db.prepare('INSERT OR IGNORE INTO proposals (scope, id, finding, brief, source) VALUES (?, ?, ?, ?, ?)');
    return transact(() => {
      let added = 0;
      for (const { finding, brief, source } of entries) {
        added += Number(insert.run(scope, finding.id, JSON.stringify(finding), JSON.stringify(brief), source).changes);
      }
      const label = { auto: 'Análisis programado', manual: 'Análisis manual', initial: 'Análisis inicial' };
      log(scope, 'scan', label[trigger] +
        ' · ' + count + ' señales detectadas · ' + added + ' propuestas nuevas.');
      return { added, detected: count };
    });
  }

  function unpack(row) {
    const experiment = row.experiment ? JSON.parse(row.experiment) : null;
    return { ...JSON.parse(row.finding), status: row.status, brief: JSON.parse(row.brief), source: row.source,
      experiment: describeExperiment(experiment) };
  }

  function snapshot(scope, days, channel) {
    return {
      ...summarize(selectRows.all(scope), days, channel),
      proposals: selectAll.all(scope).map(unpack), activity: listActivity.all(scope),
      schedule: readSchedule.get(scope) || { enabled: 0, nextAt: null },
    };
  }

  function transition(scope, id, action) {
    return transact(() => {
      const row = selectOne.get(scope, id);
      if (!row) throw new Error('La propuesta ya no está disponible.');
      const { status, experiment, message } = advanceProposal(unpack(row), action);
      log(scope, action, message);
      db.prepare('UPDATE proposals SET status = ?, experiment = ? WHERE scope = ? AND id = ?')
        .run(status, experiment ? JSON.stringify(experiment) : null, scope, id);
    });
  }

  return { ingest, addProposals, snapshot, transition, csvRows: scope => selectRows.all(scope),
    findings: scope => detect(selectRows.all(scope)),
    hasProposal: (scope, id) => Boolean(selectOne.get(scope, id)),
    setSchedule(scope, enabled) {
      writeSchedule.run(scope, enabled ? 1 : 0, enabled ? Date.now() + cadence : null);
      log(scope, 'schedule', enabled ? 'Análisis cada 15 minutos activado.' : 'Análisis programado pausado.');
    },
    claimSchedule(scope) {
      const now = Date.now();
      return Boolean(db.prepare('UPDATE schedule SET next_at = ? WHERE scope = ? AND enabled = 1 AND next_at <= ?')
        .run(now + cadence, scope, now).changes);
    },
    close: () => db.close(),
  };
}
