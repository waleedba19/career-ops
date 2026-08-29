# Search Profile (public-safe reference)

> This file is a **skills and experience reference only**. It deliberately contains
> **no name, no contact details, no location, no employer names, and no personal
> identifiers**. It exists so the automated scanner knows *what to look for and
> what to search for* without ever exposing personal data. The real private CV is
> kept offline and is never committed to any repository.

## Purpose

This profile defines the categories of **remote jobs this system actively hunts
for** and the **skills that qualify a match**. The scanner's keyword rules in
`portals.yml` are written directly from this profile, so this file and the
scanner stay in sync.

## Target role buckets (priority order)

The scanner searches these four areas, in this priority order:

1. **Arabic-English translation / localization**
   - Arabic translator, Arabic-English / English-Arabic translator
   - legal translator
   - Arabic localization, transcreation
   - Arabic linguist, Arabic language specialist

2. **Remote ESL / English teaching**
   - ESL / EFL teacher or instructor, English teacher or tutor
   - online English teaching, TESOL / TEFL certified roles
   - English language teacher

3. **Academic editing / proofreading / research support**
   - thesis editor, academic editor, academic writer
   - proofreader, academic proofreading, manuscript editor
   - research assistant, data analyst (SPSS)

4. **Vetted remote data entry / typing / admin**
   - data entry, data entry operator, typist, transcription
   - virtual assistant, administrative assistant
   - data annotation, document processing

## Skills this profile highlights (for fit scoring)

- Bilingual Arabic and English: translation, localization, transcreation
- English language teaching and curriculum delivery (ESL)
- Academic editing, proofreading, manuscript and thesis review
- Academic research support, data analysis, SPSS
- Careful, accurate handling of text and data (typing, entry, annotation)

## What the system is looking for

- **Remote-only** positions (enforced automatically).
- No technical/software roles: anything with Engineer, Developer, Software,
  DevOps, Backend, Frontend, Full Stack, QA, SRE, Security Engineer,
  Data Scientist, ML Engineer, Crypto, Blockchain is filtered **out**.
- Priority to roles that fit the four buckets above.
- Compensation and posted-date parsed where available so alerts show the price,
  freshness, and a 0-100 fit score.

## Scanner coverage

- 27 sources (free job boards and free ATS feeds, no API keys).
- Each scan checks all sources, filters by these keywords, applies the
  remote-only rule, and reports site counts plus how many matches were found.

## Notes

- This file is intentionally generic. Any detail that could identify a person
  is kept only in the offline, private CV and is never part of this repository.
