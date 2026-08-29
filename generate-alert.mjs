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
  { key: 'libya', label: 'Libya-based role (on-site or remote)', priority: 3,
    match: /libya|tripoli|benghazi/i,
    base: 80, rec: 'A local Libyan opportunity aligned with your background. Because it is in-country, it is an option even if it is not remote. Review the requirements and apply if it matches.' },
  { key: 'data', label: 'Data or administrative', priority: 4,
    match: /data (entry|analyst|annotat)|annotation|labeling|transcription|virtual assistant|admin|typing|project manager/i,
    base: 68, rec: 'An okay fit and a possible route in, but this area attracts some scams. Check that the company is a real firm before sharing any personal details.' },
];

// Hub cities/countries where an ONSITE role is useless to Waleed (non-ME
// regions he cannot work in: US/EU/Asia-Pacific etc.). Mirror of
// portals.yml location_filter.block with the Middle-East and Libya entries
// REMOVED, because those regions are now allowed on-site. When an offer's
// location string names a still-blocked hub with no remote/anywhere qualifier,
// we refuse to rank it as a strong fit or best-to-apply.
const BLOCKED_HUBS = /(^|[,\-\s])(madrid|barcelona|paris|berlin|munich|frankfurt|london|manchester|dublin|amsterdam|brussels|milan|rome|lisbon|stockholm|oslo|copenhagen|helsinki|warsaw|adelaide|sydney|melbourne|brisbane|perth|auckland|new york|los angeles|san francisco|chicago|austin|toronto|vancouver|jakarta|bangkok|manila|mumbai|delhi|bangalore|karachi|lahore|lagos|nairobi|johannesburg|cape town|spain|usa|united states|uk|united kingdom|canada|australia|france|germany|italy|netherlands|poland|sweden|norway|denmark|finland|ireland|portugal|japan|south korea|china|brazil|mexico|argentina|colombia|chile|india|pakistan|bangladesh|sri lanka|nigeria|kenya|ghana|south africa|indonesia|philippines|malaysia|vietnam|thailand)([,\-\s]|$)/i;

// Middle-East / Arab-world countries+their hubs (allowed on-site as of the 2026
// Libya/ME expansion) plus Libya. Used to mark such roles as eligible rather
// than applying the on-site penalty.
const ME_LIBYA_HUBS = /(^|[,\-\s])(dubai|riyadh|doha|kuwait|manama|muscat|cairo|alexandria|casablanca|tunis|amman|beirut|istanbul|ankara|libya|tripoli|benghazi|uae|united arab emirates|saudi|saudi arabia|qatar|bahrain|oman|egypt|morocco|tunisia|jordan|lebanon|turkey|kuwait)([,\-\s]|$)/i;

// Returns 'remote' | 'onsite' | 'me' | 'unknown' based on the location field.
function locationKind(loc) {
  const s = String(loc || '').toLowerCase();
  if (!s) return 'unknown';
  if (/remote|anywhere|worldwide|global|online|home ?based|virtual/.test(s)) return 'remote';
  if (ME_LIBYA_HUBS.test(s)) return 'me';
  if (BLOCKED_HUBS.test(s)) return 'onsite';
  return 'unknown';
}

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

// Fit score: bucket base, +8 if fresh, +6 if pay present, -12 if old, -12 if
// trust-warning. Location/eligibility terms: an onsite role in a blocked hub is
// NOT eligible for remote-only Waleed, so it is capped hard (and never a best
// pick); an unknown location gets a small penalty but is still shown.
function fitScore(o, b, age, kind) {
  let s = b.base;
  if (age.fresh) s += 6;
  else if (age.text.includes('several days') || /days ago/.test(age.text) && /[3-9]|1\d/.test(age.text)) s -= 10;
  if (o.comp) s += 6;
  if (o.trust != null && o.trust < 100) s -= 10;
  if (kind === 'onsite') { s = Math.min(s, 15); s -= 40; }
  else if (kind === 'unknown') s -= 6;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function money(o) { return o.comp ? o.comp : 'Not advertised'; }

const offers = parse(readFileSync(offersPath, 'utf-8'));
const n = offers.length;

// A role counts as a STRONG MATCH when it clears this fit threshold. Such roles
// are put first, marked "STRONG MATCH", and highlighted in red in the email so
// Waleed spots the genuinely high-confidence apply-worthy ones at a glance.
const STRONG_MATCH_SCORE = 88;

// Enrich each offer
const detailed = offers.map((o) => {
  const b = bucketFor(o);
  const age = ageInfo(o.postedMs);
  const kind = locationKind(o.location);
  const score = fitScore(o, b, age, kind);
  const strong = score >= STRONG_MATCH_SCORE;
  return { o, b, age, score, kind, strong };
});

// Sort: score desc, then fresh first
detailed.sort((a, b2) => (b2.score - a.score) || (b2.o.postedMs - a.o.postedMs));

// Best pick = the top *eligible* (remote or unknown) option with pay and fresh,
// else simply the top score of an eligible option.
const bestRemote = detailed.find((d) => d.kind !== 'onsite');
const best = bestRemote || null;

function humanOffer(d) {
  const { o, b, age, score, kind, strong } = d;
  const lines = [];
  lines.push(`${o.company} is hiring a ${o.title} (${o.location || 'remote'}).`);
  lines.push(`Field: ${b.label}. Pay: ${money(o)}. Age: ${age.text}.`);
  if (age.urgent) lines.push('This is fresh, so apply fast while the role is still open.');
  lines.push(`Fit for your CV: around ${score} out of 100.`);
  if (strong) lines.push('STRONG MATCH: this lines up strongly with your experience and is worth applying to.');
  if (kind === 'onsite') {
    lines.push('Caution: this is based in one of the countries you cannot relocate to, and it does not clearly say remote. Treat it as on-site, not a remote fit, and only apply if you are sure.');
  } else if (kind === 'me') {
    lines.push('This is in Libya or the Middle East, so it is a genuine option for you even if it is on-site. Worth a look.');
  } else if (kind === 'unknown') {
    lines.push('Note: the listing does not say where it is based or whether it is remote. Check the posting before applying.');
  }
  lines.push(`My recommendation: ${b.rec}`);
  lines.push(`Link to apply: ${o.url} (from ${hostname(o.url)})`);
  return lines.join('\n');
}

// ----- Run reasoning ---------------------------------------------------------
// This is the "intelligent" part: instead of sending the same canned message
// every run, we look at what THIS run actually produced and choose a fitting
// message. A run can land in one of several states:
//   found-many   -> several genuinely new roles
//   found-one    -> exactly one new role
//   found-none   -> nothing new this scan
// Each state gets its own lead line, body emphasis, and closing, and the email
// and Telegram messages are deliberately different in shape but consistent in
// facts. The script is fed only the NEW offers of this run, so "new" is exactly
// what changed since the last scan.

const SLOTS = [
  { t: 7,  label: '07:00' }, { t: 10, label: '10:00' }, { t: 13, label: '13:00' },
  { t: 16, label: '16:00' }, { t: 19, label: '19:00' }, { t: 22, label: '22:00' },
];
function tripoliHours() {
  // Convert current UTC to local Tripoli time (UTC+2) without timezone libs.
  const d = new Date(now + 2 * 3600 * 1000);
  return d.getUTCHours();
}
function nextSlotText() {
  const h = tripoliHours();
  for (const s of SLOTS) if (s.t > h) return `The next scan is at ${s.label} today.`;
  return 'The next scan is tomorrow at 07:00.';
}

function leadLine() {
  if (n === 0) {
    return 'This scan found no new roles that match your experience. The last matches still stand and the workbook still holds them.';
  }
  const freshCount = detailed.filter((d) => d.age.fresh).length;
  const totalFound = `Found ${n} new role${n === 1 ? '' : 's'} this scan.`;
  if (freshCount > 0 && n > 1) return `${totalFound} ${freshCount} of them look fresh, so timing is on your side.`;
  if (n === 1) return 'One new role appeared this scan.';
  return totalFound;
}

// ----- Telegram body (short, scannable, reasoned for this run) -----
let tg = [];
tg.push('Hello Waleed, your remote jobs update.');
tg.push('');
if (n === 0) {
  tg.push('Nothing new this scan. No fresh role matched your experience in the last run.');
  tg.push('');
  tg.push('The previous matches are still in the workbook. Next scan:');
  const nx = nextSlotText();
  tg.push(nx);
  tg.push('');
  tg.push('If you want, I can re-scan now or focus on a specific company.');
} else if (n === 1) {
  tg.push('A new role showed up this scan.');
  tg.push('');
  tg.push(humanOffer(detailed[0]));
  tg.push('');
  tg.push(`Best one to apply to right now is ${best.o.company}, the ${best.o.title}, fit ${best.score} out of 100. ${best.age.text}.`);
  if (best.age.urgent) tg.push('It is fresh, so do not sit on it.');
  tg.push('');
  tg.push('Say the company name and I will read the posting, fill the application from your CV, and draft your message for review.');
} else {
  tg.push(leadLine());
  tg.push('');
  detailed.slice(0, 4).forEach((d) => { tg.push(humanOffer(d)); tg.push(''); });
  if (n > 4) tg.push(`Plus ${n - 4} more in the email and the workbook.`);
  tg.push('');
  tg.push('How to act: pick a company and tell me the name. I will read the whole posting, fill the application from your CV, and draft your message. You review and submit; nothing goes out without you.');
  if (best && best.age.urgent) tg.push('The best one to apply to right now is the top one above; it is fresh.');
}
tg.push('');
tg.push('Full detail and the complete browse list are in the Excel workbook attached to the email (two sheets: Matches and the wide All Jobs 700+).');
writeFileSync('/tmp/alert-telegram.txt', tg.join('\n'));

// ----- Email body (plain text, reasoned for this run, distinct from TG) -----
let em = [];
em.push('Hello Waleed, here is your remote jobs update.');
em.push('');

if (n === 0) {
  em.push('Nothing new to report this scan. Every relevant posting is still the ones you already saw.');
  em.push('');
  em.push('This is normal: most scans of a single day do not surface brand new roles. The scan pulled the full list again and no new match crossed your threshold this time.');
  em.push('');
  em.push(nextSlotText());
  em.push('');
  em.push('The workbook I am attaching has the wide browse sheet (every job found today) and the strict matches sheet. You can always look through the wide sheet yourself, or ask me to chase a specific company.');
} else if (n === 1) {
  em.push(leadLine());
  em.push('');
  detailed.forEach((d) => { em.push('=================================='); pushEmailOffer(em, d); });
  em.push('');
  em.push('HOW TO ACT');
  em.push(`Tell me the company (${detailed[0].o.company}) and I will read the whole posting, fill the application from your CV, and draft your message for your review. Nothing goes out without you.`);
} else {
  em.push('Below are the new roles, with field, pay, how fresh, a fit score, and my recommendation.');
  em.push('');
  if (best) {
    em.push('BEST TO APPLY RIGHT NOW');
    em.push(`${best.o.company}, the ${best.o.title}. Fit ${best.score} out of 100. ${best.age.text}.${best.age.urgent ? ' This one is fresh, so apply soon.' : ''}`);
    em.push(`Apply at ${best.o.url}`);
    em.push('');
  }
  detailed.forEach((d) => { em.push('=================================='); pushEmailOffer(em, d); });
}
em.push('');
const nx0 = nextSlotText();
em.push(nx0);
em.push('');
em.push('ABOUT THE WORKBOOK');
em.push('I am attaching career-matches.xlsx. It has two clearly different sheets:');
em.push('- "All Jobs 700+" is the wide browse sheet: every single job found today across all sources, so you can search far beyond your exact match.');
em.push('- The day sheet (for example 29-8-2026) holds only your strict CV matches, stacked by each scan run. Today\'s wide sheet is rebuilt once per day at 09:00 and kept for the rest of the day.');
em.push('Open it in Excel or Google Sheets to browse.');
em.push('');
em.push('Regards,');
em.push('Your CareerOps assistant');
writeFileSync('/tmp/alert-email.md', em.join('\n'));

function pushEmailOffer(emArr, d) {
  const { o, b, age, score, strong } = d;
  // STRONG MATCH roles are wrapped in a sentinel pair that send_alert.py turns
  // into red styling in the HTML email, so the genuinely high-confidence,
  // apply-worthy roles visually pop above the rest.
  const openTag = strong ? '⟪STRONG⟫' : '';
  const closeTag = strong ? '⟪/STRONG⟫' : '';
  emArr.push(`${openTag}${o.company} - ${o.title}${closeTag}`);
  emArr.push(`Field: ${b.label}`);
  emArr.push(`Pay: ${money(o)}`);
  emArr.push(`Age: ${age.text}`);
  if (age.urgent) emArr.push('This is fresh, so apply fast.');
  emArr.push(`${openTag}Fit for your CV: ${score} out of 100${closeTag}`);
  if (strong) emArr.push('STRONG MATCH: this lines up strongly with your experience and is worth applying to.');
  emArr.push(`Recommendation: ${b.rec}`);
  emArr.push(`Apply at: ${o.url}`);
  emArr.push(`Source site: ${hostname(o.url)}`);
  emArr.push('');
}

// ----- CSV export (for email attachment) -----
// Note: we write to a distinct path so we never clobber data/pipeline.csv, which
// export-pipeline-csv.mjs owns as the running ledger of every job in the pipeline.
// This file is the enriched per-scan view: fit score, field, pay, age, urgency.
const f = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const head = ['fit_score', 'field', 'company', 'title', 'location', 'pay', 'age', 'urgency', 'url', 'source_site', 'eligible'];
const rows = detailed.map((d) => {
  const { o, b, age, score, kind } = d;
  const urgency = !o.postedMs ? 'unknown' : (age.urgent ? 'urgent' : (age.fresh ? 'fresh' : 'old'));
  return [score, b.label, o.company, o.title, o.location, money(o), age.text, urgency, o.url, hostname(o.url), kind !== 'onsite' ? 'yes' : 'no'].map(f).join(',');
});
writeFileSync('/tmp/alert-rows.csv', head.join(',') + '\n' + rows.join('\n') + '\n');

console.log(`alert built: ${n} offers, best=${best ? `${best.o.company} (${best.score})` : 'n/a'}`);