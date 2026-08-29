#!/usr/bin/env node
// export-pipeline-csv.mjs
// Zero-dependency: converts data/pipeline.md (- [ ] url | company | role | location)
// into data/pipeline.csv so notifications can link a spreadsheet the user opens
// in Excel / Google Sheets from any device. Runs inside the GitHub workflow after
// each scan; data/ is force-added on commit so the CSV stays fresh in the repo.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Script lives at the repo root — dirname is the repo root itself.
const root = dirname(fileURLToPath(import.meta.url));
const pipelinePath = join(root, 'data', 'pipeline.md');
const csvPath = join(root, 'data', 'pipeline.csv');

const field = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const hostname = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

const lines = readFileSync(pipelinePath, 'utf-8').split('\n');
const rows = [];
for (const raw of lines) {
  const m = raw.match(/^\s*-\s*\[([ xX])\]\s+(\S+)\s*\|\s*(.*)$/);
  if (!m) continue;
  const [, checked, url, rest] = m;
  const parts = rest.split('|').map((p) => p.trim());
  const [company = '', role = '', location = ''] = parts;
  rows.push([
    checked.trim().toLowerCase() === 'x' ? 'processed' : 'pending',
    url, hostname(url), company, role, location,
  ]);
}

const header = ['status', 'url', 'source_site', 'company', 'role', 'location'];
writeFileSync(csvPath, header.join(',') + '\n' + rows.map((r) => r.map(field).join(',')).join('\n') + '\n');
console.log(`pipeline.csv: ${rows.length} rows written`);