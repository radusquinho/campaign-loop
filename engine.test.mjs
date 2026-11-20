import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoRows, detect, encodeCampaignCsv, experimentResult, parseCampaignCsv } from './engine.mjs';
import { openStore } from './store.mjs';

test('CSV validates all rows, handles quoted names and prevents duplicate keys', () => {
  const rows = demoRows('2026-10-20');
  const first = { ...rows[0], campaign: 'Oferta, "edición limitada"' };
  assert.deepEqual(parseCampaignCsv(encodeCampaignCsv([first])), [first]);
  assert.throws(() => parseCampaignCsv(encodeCampaignCsv([first, first])), /fila 3/);
  assert.throws(() => parseCampaignCsv(encodeCampaignCsv([{ ...first, date: '2026-02-30' }])), /fila 2/);
  assert.throws(() => parseCampaignCsv(encodeCampaignCsv([{ ...first, clicks: first.impressions + 1 }])), /fila 2/);
});

test('rules need two full windows and reproduce the same fingerprint with unchanged data', async () => {
  const rows = demoRows('2026-10-20');
  const findings = await detect(rows);
  assert.ok(findings.length >= 3);
  assert.ok(findings.some(finding => finding.metric === 'ctr'));
  assert.deepEqual(await detect(rows), findings);
  assert.deepEqual(await detect(rows.slice(-42)), []);
});

test('result waits for the prespecified sample and distinguishes inconclusive results', () => {
  assert.equal(experimentResult({ n: 400, x: 40 }, { n: 400, x: 80 }, 2000).status, 'collecting');
  assert.equal(experimentResult({ n: 2000, x: 150 }, { n: 2000, x: 150 }, 2000).status, 'inconclusive');
  assert.equal(experimentResult({ n: 2000, x: 200 }, { n: 2000, x: 300 }, 2000).status, 'variant');
  assert.equal(experimentResult({ n: 2000, x: 300 }, { n: 2000, x: 200 }, 2000).status, 'control');
  assert.equal(experimentResult({ n: 2000, x: 0 }, { n: 2000, x: 0 }, 2000).status, 'inconclusive');
});

test('SQLite separates datasets, making scans idempotent and guarding the approval lifecycle', async () => {
  const store = openStore(':memory:');
  try {
    const rows = demoRows('2026-10-20');
    store.ingest('workspace', rows);
    store.ingest('workspace', rows);
    assert.equal(store.snapshot('workspace', 14, '').rowCount, rows.length);
    const [finding] = await store.findings('workspace');
    const proposals = [{ finding, brief: { variant: finding.variant }, source: 'Reglas' }];
    assert.equal(store.addProposals('workspace', proposals, 'manual', 1).added, 1);
    assert.equal(store.addProposals('workspace', proposals, 'manual', 1).added, 0);
    assert.equal(store.snapshot('demo', 14, '').proposals.length, 0);
    assert.throws(() => store.transition('workspace', finding.id, 'simulate'), /acción/);
    store.transition('workspace', finding.id, 'approve');
    assert.throws(() => store.transition('workspace', finding.id, 'approve'), /acción/);
    for (let i = 0; i < 5; i++) store.transition('workspace', finding.id, 'simulate');
    const [run] = store.snapshot('workspace', 14, '').proposals;
    assert.equal(run.status, 'complete');
    assert.equal(run.experiment.a.n, 2000);
    assert.equal(run.experiment.b.n, 2000);
    assert.throws(() => store.transition('workspace', finding.id, 'simulate'), /acción/);
    store.setSchedule('workspace', true);
    assert.equal(store.snapshot('workspace', 14, '').schedule.enabled, 1);
    assert.equal(store.claimSchedule('workspace'), false);
    store.setSchedule('workspace', false);
    assert.equal(store.snapshot('workspace', 14, '').schedule.nextAt, null);
  } finally {
    store.close();
  }
});
