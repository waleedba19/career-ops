#!/usr/bin/env node
// generate-alert.mjs
// Zero-dependency alert builder. Reads the scan's new offers (with URLs) and
// produces a self-describing, CV-aware alert for BOTH channels:
//   - /tmp/alert-telegram.txt   (plain text, icons + tags + how-to-apply)
//   - /tmp/alert-email.md       (markdown, same content, links clickable)
//   - data/pipeline.csv         (refreshed spreadsheet export for attachment)
// The Scanner writes one offer per line as:  + Company | Title | Location | url
// Each offer is bucketed + tagged against the CV profile, so the user sees WHY
// it fits and what to do next.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const offersPath = process.argv[2] || '/tmp/new-offers.txt';

// --- CV profile (from config/profile.yml, distilled for tagging) ---
const BUCKETS = [
  {
    key: 'translation', icon: '🌍', label: 'Translation / Localization', priority: 1,
    match: /translat|localiz|localisation|localization|l10n|i18n|linguist|interpreter|proofread|copywriter.*arabic|arabic.*writing|language lead|language specialist/i,
    note: 'Core strength — 3 yrs legal translation + academic translation. Highest-value target.',
  },
  {
    key: 'esl', icon: '🗣️', label: 'ESL / English Teaching', priority: 2,
    match: /esl|tefl|tesol|english.*(teacher|tutor|trainer)|teach.*english|online.*(teacher|tutor)|language (coach|tutor)|ai tutor|tutor.*arabic|arabic.*tutor|language.*coordinator/i,
    note: 'Strong fit — ESL trainer (Nat. Oil Corp) + online teaching experience.',
  },
  {
    key: 'academic', icon: '🎓', label: 'Academic / Research', priority: 3,
    match: /academic|research|thesis|editor|proofread|curriculum|education|instructional design|study/i,
    note: 'Good fit — MA Applied Linguistics, 15 supervised theses, academic editing.',
  },
  {
    key: 'data', icon: '📊', label: 'Data / Rem. Admin', priority: 4,
    match: /data (entry|analyst|annotat)|annotation|labeling|transcription|virtual assistant|admin|typing|project manager/i,
    note: 'Adjacent fit — solid for entry-mid roles; verify legitimacy first (scam-heavy).',
  },
];

// --- Parse offers:  + Company | Title | Location | url [ | extra...] ---
function parseOffers(text) {
  const offers = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*\+\s*/, '').trim();
    if (!line) continue;
    const parts = line.split('|').map((s) => s.trim());
    const [company = '', title = '', location = '', url = ''] = parts;
    if (!title && !url) continue;
    offers.push({
      company, title, location,
      url: url.replace(/[\[\]<>()]/g, ''), // strip any markdown/angle wrappers
      raw: parts.slice(4).join(' | '),
    });
  }
  return offers;
}

function bucketFor(offer) {
  const hay = `${offer.title} ${offer.company} ${offer.location}`;
  for (const b of BUCKETS) {
    if (b.match.test(hay)) return b;
  }
  return { key: 'general', icon: '💼', label: 'General Remote', priority: 9, note: 'Might fit — review the posting to confirm.' };
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') || url; } catch { return url; }
}

// --- Build shared per-offer block (used by both channels) ---
function offerLine(o, md) {
  const b = bucketFor(o);
  const link = md ? `[Apply → ${hostname(o.url)}](${o.url})` : `${o.url}`;
  return [
    `${b.icon} **${o.company}** — ${o.title}`,
    `   📍 ${o.location || 'Remote'}  •  🏷️ ${b.label}`,
    `   ${link}`,
    `   💡 ${b.note}`,
  ].join('\n');
}

const offers = parseOffers(readFileSync(offersPath, 'utf-8'));
const n = offers.length;

// ---- TELEGRAM (plain text, ~3500 chars cap) ----
const tgLines = [
  '🔍 *CareerOps — New Remote Job Matches*',
  '',
  `Hi Waleed 👋 — ${n} new ${n === 1 ? 'job' : 'jobs'} found that match your profile.`,
  'Each one is tagged with the field it fits and a note on why it suits your CV.',
  '',
];
const list = offers.map((o) => offerLine(o, false));
tgLines.push(...list.slice(0, 12));
if (offers.length > 12) tgLines.push(`\n… +${offers.length - 12} more — open the attached Excel/CSV for the full list.`);
tgLines.push(
  '',
  '🏷️ Tags: 🌍 translation  •  🗣️ ESL teaching  •  🎓 academic  •  📊 data',
  '',
  '──────────────────────────',
  '*How to apply (3 steps, ~5 min each):*',
  '1️⃣  Open the 📊 CSV spreadsheet attached to the email (or ask me to open it on your PC).',
  '2️⃣  Pick one job you like and tell me the company name — I will read the posting,',
  '     pre-fill the whole application from your CV, and draft your cover message.',
  '3️⃣  You review → click **Submit**. Nothing is ever sent without you.',
  '',
  '💬 To get a deep breakdown of any job, reply with its company name and I will',
  '     analyse the full posting, requirements, and how it maps to your experience.',
);
writeFileSync('/tmp/alert-telegram.txt', tgLines.join('\n'));

// ---- EMAIL (markdown) ----
const mdList = offers.map((o) => offerLine(o, true)).join('\n\n');
const md = [
  '# 🔍 CareerOps — New Remote Job Matches',
  '',
  `Hi Waleed 👋 — this scan found **${n} new** remote job(s) matching your profile.`,
  'Each is tagged by field (🌍 translation / 🗣️ ESL / 🎓 academic / 📊 data) with a note on why it fits your CV.',
  '',
  '---',
  '',
  '## 📌 Today\'s matches',
  '',
  mdList,
  '',
  '---',
  '',
  '## 🧭 What to do next',
  '',
  '1. **Open the attached CSV spreadsheet** (`pipeline.csv`) — it lists every match with a clickable link, source site, and field tag. Open it in Excel or Google Sheets.',
  '2. **Pick one company** and tell me (in PawWork chat): *"start the application for [company]"*.',
  '3. I will **read the posting, pre-fill the whole form from your CV** (work history, education, skills, availability, cover message) and stop exactly at Submit.',
  '4. **You click Submit.** Nothing is ever auto-submitted — you keep full control.',
  '',
  '## 💬 Want deeper detail on a job?',
  '',
  'Reply with any company name from this list and I will give you a full analysis: the posting requirements, how it maps to your experience, likely questions, and a tailored cover message — before you commit.',
  '',
  '---',
  '',
  '🏷️ *Fields: 🌍 translation  •  🗣️ ESL  •  🎓 academic  •  📊 data*',
  '',
  '— CareerOps automatic scanner',
].join('\n');
writeFileSync('/tmp/alert-email.md', md);

// ---- CSV export (for attachment + on-GitHub preview if ever needed) ----
const csvLine = (o) => {
  const f = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const b = bucketFor(o);
  return [f(b.label), f(o.company), f(o.title), f(o.location), f(o.url), f(hostname(o.url))].join(',');
};
const csvPath = join(root, 'data', 'pipeline.csv');
writeFileSync(csvPath, 'field,company,title,location,url,source_site\n' + offers.map(csvLine).join('\n') + '\n');

console.log(`alert built: ${n} offers → telegram(${tgLines.join('\n').length} chars), email(${md.length} chars), csv(${offers.length} rows)`);