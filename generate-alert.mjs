#!/usr/bin/env node
// generate-alert.mjs
// Builds a human, plain-language alert from the scan's new offers.
// Scanner emits one line per offer, in this shape (fields after url are optional):
//   + Company | Title | Location | url [ | 1000-2000 USD | posted: 2026-08-29] [ | trust: ...]
// Produces:
//   /tmp/alert-telegram.txt   plain human text (no markdown symbols)
//   /tmp/alert-email.md       plain-text email body (no markdown symbols)
//   /tmp/alert-rows.csv       enriched per-scan rows (email attachment)
//
// Each offer gets: field tag, pay range if known, posting age + urgency, a fit
// score out of 100 based on the CV profile, and a short recommendation. A "best
// to apply right now" pick is added at the top when there is a strong, fresh,
// high-pay option.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const offersPath = process.argv[2] || '/tmp/new-offers.txt';
const now = Date.now();
const HOUR = 3600 * 1000;

// CV profile, distilled from config/profile.yml. Weight reflects how strongly
// each field matches Waleed's background on a 0-100 scale.
const PROFILE = {
  nativeArabic: true,
  englishC1: true,
  maAppliedLinguistics: true,
  legalTranslationYears: 3,
  eslTrainer: true,
  onlineTeaching: true,
  academicEditing: true,
  thesesSupervised: 15,
  dataEntryExperience: true,
};

const BUCKETS = [
  { key: 'translation', label: 'Arabic English translation or localization', priority: 1,
    match: /translat|localiz|localisation|localization|l10n|i18n|linguist|interpreter|proofread|copywriter.*arabic|arabic.*writing|language lead|language specialist/i,
    base: 88, rec: 'You are an exact fit. You have 3 years of professional legal translation plus academic translation, and native Arabic with C1 English. Apply today.' },
  { key: 'esl', label: 'English teaching', priority: 2,
    match: /esl|tefl|tesol|english.*(teacher|tutor|trainer)|teach.*english|online.*(teacher|tutor)|language (coach|tutor)|ai tutor|tutor.*arabic|arabic.*tutor|language.*coordinator/i,
    base: 82, rec: 'A very strong fit. You trained professionals as an ESL trainer and have online teaching experience, backed by an MA in Applied Linguistics.' },
  { key: 'academic', label: 'Academic or research support', priority: 3,
    match: /academic|research|thesis|editor|proofread|curriculum|education|instructional design|study/i,
    base: 78, rec: 'A good fit. You have supervised 15 graduate theses and done academic editing and research support, which fits this type of role.' },
  { key: 'data', label: 'Data or administrative', priority: 4,
    match: /data (entry|analyst|annotat)|annotation|labeling|transcription|virtual assistant|admin|typing|project manager/i,
    base: 68, rec: 'An okay fit and a possible route in, but this area attracts some scams. Check that the company is a real firm before sharing any personal details.' },
];

function bucketFor(o) {
  const hay = `${o.title} ${o.company} ${o.location}`;
  for (const b of BUCKETS) if (b.match.test(hay)) return b;
  return { key: 'general', label: 'general remote', priority: 9,
    base: 62, rec: 'It might fit you, so open the posting and see the requirements before deciding.' };
}

function hostname(url) { try { return new URL(url).hostname.replace(/^www\./, '') || url; } catch { return url; } }

function parse(offersText) {
  const out = [];
  for (const raw of offersText.split('\n')) {
    const line = raw.replace(/^\s*\+\s*/, '').trim();
    if (!line) continue;
    const parts = line.split('|').map((s) => s.trim());
    const [company = '', title = '', location = '', url = ''] = parts;
    if (!title && !url) continue;
    const rec = { company, title, location, url: url.replace(/[\[\]<>()]/g, ''),
      comp: '', postedMs: 0, trust: null };
    for (const p of parts.slice(4)) {
      // Posted date, possibly followed by a bracketed trust/blacklist suffix,
      // e.g. "posted: 2026-08-29 [Trust: 70/100 missing_apply_url]".
      const pm = p.match(/^posted:\s*(\d{4}-\d{2}-\d{2})(?:\s*\[.*)?$/i);
      if (pm) rec.postedMs = new Date(pm[1] + 'T00:00:00Z').getTime();
      const tm = p.match(/^trust:\s*(\d+)|\bTrust:\s*(\d+)\//i);
      if (tm) { const n = parseInt(tm[1] || tm[2], 10); if (!isNaN(n)) rec.trust = n; }
      if (!pm && !tm && /\d/.test(p) && !/posted:/i.test(p) && !/trust:/i.test(p)
          && /(usd|eur|gbp|us\$|\$\s?\d|per|year|annual|k\b)/i.test(p)) rec.comp = p;
      else if (!pm && !tm && !rec.comp && /\d+[-–]\d+/.test(p) && !/posted:|trust:/i.test(p)) rec.comp = p;
    }
    out.push(rec);
  }
  return out;
}

function ageInfo(postedMs) {
  if (!postedMs) return { text: 'posting date not shown', urgent: false, fresh: false };
  const age = now - postedMs;
  const d = Math.floor(age / (24 * HOUR));
  const h = Math.floor(age / HOUR);
  if (age < 6 * HOUR) return { text: `just posted, about ${Math.max(h, 0) || '<1'} hour${h === 1 ? '' : 's'} ago`, urgent: true, fresh: true };
  if (age < 24 * HOUR) return { text: `posted today, ${h} hour${h === 1 ? '' : 's'} ago`, urgent: true, fresh: true };
  if (d <= 3) return { text: `posted ${d} day${d === 1 ? '' : 's'} ago`, urgent: false, fresh: true };
  return { text: `posted ${d} days ago, several days old`, urgent: false, fresh: false };
}

// Fit score: bucket base, +8 if fresh, +6 if pay present, -12 if old, -12 if trust-warning.
function fitScore(o, b, age) {
  let s = b.base;
  if (age.fresh) s += 6;
  else if (age.text.includes('several days') || /days ago/.test(age.text) && /[3-9]|1\d/.test(age.text)) s -= 10;
  if (o.comp) s += 6;
  if (o.trust != null && o.trust < 100) s -= 10;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function money(o) { return o.comp ? o.comp : 'Not advertised'; }

const offers = parse(readFileSync(offersPath, 'utf-8'));
const n = offers.length;

// Enrich each offer
const detailed = offers.map((o) => {
  const b = bucketFor(o);
  const age = ageInfo(o.postedMs);
  const score = fitScore(o, b, age);
  return { o, b, age, score };
});

// Sort: score desc, then fresh first
detailed.sort((a, b2) => (b2.score - a.score) || (b2.o.postedMs - a.o.postedMs));

// Best pick = highest score with pay and fresh, else top score
const best = detailed[0];

function humanOffer(d) {
  const { o, b, age, score } = d;
  const lines = [];
  lines.push(`${o.company} is hiring a ${o.title} (${o.location || 'remote'}).`);
  lines.push(`Field: ${b.label}. Pay: ${money(o)}. Age: ${age.text}.`);
  if (age.urgent) lines.push('This is fresh, so apply fast while the role is still open.');
  lines.push(`Fit for your CV: around ${score} out of 100.`);
  lines.push(`My recommendation: ${b.rec}`);
  lines.push(`Link to apply: ${o.url} (from ${hostname(o.url)})`);
  return lines.join('\n');
}

// ----- Telegram body (plain, human, no symbols) -----
let tg = [];
tg.push('Hello Waleed, here is your remote jobs update.');
tg.push(`${n} new role${n === 1 ? '' : 's'} were found that match your experience.`);
tg.push('');
if (best) {
  tg.push(`Best one to apply to right now is ${best.o.company}, the ${best.o.title}, with a fit of ${best.score} out of 100. ${best.age.text}.`);
  if (best.age.urgent) tg.push('Since it is fresh, do not delay on it.');
  tg.push('');
}
detailed.slice(0, 8).forEach((d) => { tg.push(humanOffer(d)); tg.push(''); });
if (detailed.length > 8) tg.push(`Plus ${detailed.length - 8} more in the spreadsheet.`);
tg.push('');
tg.push('How to act: pick a company from the list and tell me the name. I will read the whole posting, fill the application from your CV, and draft your message. You review it and submit. Nothing goes out without your approval.');
tg.push('');
tg.push('You can ask me for a deeper write up on any of these companies or roles at any time.');
writeFileSync('/tmp/alert-telegram.txt', tg.join('\n'));

// ----- Email body (plain text, no markdown symbols) -----
let em = [];
em.push('Hello Waleed, here is your remote jobs update.');
em.push('');
em.push(`${n} new roles were found that match your experience. Below each role you will find the field, the pay if the company published it, how fresh the posting is, a fit score out of 100 based on your CV, and my recommendation.`);
em.push('');
if (best) {
  em.push('BEST TO APPLY RIGHT NOW');
  em.push(`${best.o.company}, ${best.o.title}. Fit ${best.score} out of 100. Age: ${best.age.text}.${best.age.urgent ? ' This one is fresh, apply soon.' : ''}`);
  em.push(`Apply at ${best.o.url}`);
  em.push('');
}
detailed.forEach((d) => {
  const { o, b, age, score } = d;
  em.push('==================================');
  em.push(`${o.company} - ${o.title}`);
  em.push(`Field: ${b.label}`);
  em.push(`Pay: ${money(o)}`);
  em.push(`Age: ${age.text}`);
  if (age.urgent) em.push('This is fresh, apply fast.');
  em.push(`Fit for your CV: ${score} out of 100`);
  em.push(`Recommendation: ${b.rec}`);
  em.push(`Apply at: ${o.url}`);
  em.push(`Source site: ${hostname(o.url)}`);
  em.push('');
});
em.push('A spreadsheet with all these roles is attached to this email as pipeline.csv. Open it in Excel or Google Sheets to filter and sort.');
em.push('');
em.push('HOW TO ACT');
em.push('Tell me the company you want and I will read the whole posting, fill the application from your CV, and draft your message. You review it and submit. Nothing goes out without your approval.');
em.push('');
em.push('You can ask me for a deeper write up on any company or role at any time.');
em.push('');
em.push('Regards,');
em.push('Your CareerOps assistant');
writeFileSync('/tmp/alert-email.md', em.join('\n'));

// ----- CSV export (for email attachment) -----
// Note: we write to a distinct path so we never clobber data/pipeline.csv, which
// export-pipeline-csv.mjs owns as the running ledger of every job in the pipeline.
// This file is the enriched per-scan view: fit score, field, pay, age, urgency.
const f = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const head = ['fit_score', 'field', 'company', 'title', 'location', 'pay', 'age', 'urgency', 'url', 'source_site'];
const rows = detailed.map((d) => {
  const { o, b, age, score } = d;
  const urgency = !o.postedMs ? 'unknown' : (age.urgent ? 'urgent' : (age.fresh ? 'fresh' : 'old'));
  return [score, b.label, o.company, o.title, o.location, money(o), age.text, urgency, o.url, hostname(o.url)].map(f).join(',');
});
writeFileSync('/tmp/alert-rows.csv', head.join(',') + '\n' + rows.join('\n') + '\n');

console.log(`alert built: ${n} offers, best=${best ? `${best.o.company} (${best.score})` : 'n/a'}`);