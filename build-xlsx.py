#!/usr/bin/env python3
"""build-xlsx.py - accumulate scan results into one growing Excel workbook.

One file (default data/matches.xlsx) with one sheet per day, named by the day
(Excel forbids "/" in tab names, so a date is written as e.g. 29-8-2026).
Inside each day's sheet, every scan run of that day is appended as a set of
stacked tables (one below the other), each labelled with its run time, so a
full day with 6 runs shows 6 stacked match tables (plus their fuller lists).

If today's sheet already exists (a later run of the same day), we append a new
stacked table below the previous ones instead of overwriting. Tomorrow creates
a fresh sheet in the same file, so the workbook grows across days.

Inputs (env):
  MATCHES_CSV       enriched per-run matches (from generate-alert.mjs)
  CANDIDATES_JSON   relevant candidates this run (from scan.mjs)
  OUT_XLSX          path to the accumulating workbook (default data/matches.xlsx)
  RUN_LABEL         label for this run's table (e.g. "13:00"); optional
  TZ_OFFSET_H       hours offset for local-day naming (default 2, Tripoli)
"""

import csv
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

matches_csv = os.environ.get("MATCHES_CSV", "/tmp/alert-rows.csv")
candidates_json = os.environ.get("CANDIDATES_JSON", "data/candidates.json")
out_xlsx = os.environ.get("OUT_XLSX", "data/matches.xlsx")
run_label = os.environ.get("RUN_LABEL", "").strip()
tz_offset = float(os.environ.get("TZ_OFFSET_H", "2"))

HEADER_FILL = PatternFill("solid", fgColor="1F4E79")
HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
RUN_FILL = PatternFill("solid", fgColor="DDEBF7")
RUN_FONT = Font(bold=True, size=12, color="1F4E79")
LINK_FONT = Font(color="0563C1", underline="single")
URGENT_FILL = PatternFill("solid", fgColor="FFEB9C")
THIN = Side(style="thin", color="D0D0D0")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
CENTER = Alignment(horizontal="center")


def local_now():
    return datetime.now(timezone.utc) + timedelta(hours=tz_offset)


def day_name(dt):
    # Excel tab names cannot contain "/" -> use dashes: 29-8-2026
    return f"{dt.day}-{dt.month}-{dt.year}"


def style_header(ws, row, headers):
    for c, _ in enumerate(headers, start=1):
        cell = ws.cell(row=row, column=c, value=headers[c - 1])
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT


def write_row(ws, row, values, headers):
    for c in range(1, len(headers) + 1):
        ws.cell(row=row, column=c).value = values[c - 1]
        ws.cell(row=row, column=c).border = BORDER


def write_link(ws, row, col, url, display=None):
    cell = ws.cell(row=row, column=col, value=display or url)
    if url and url.startswith("http"):
        cell.hyperlink = url
        cell.font = LINK_FONT
    return cell


def read_matches():
    if not os.path.exists(matches_csv):
        return []
    with open(matches_csv, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def read_candidates():
    if not os.path.exists(candidates_json):
        return []
    try:
        with open(candidates_json, encoding="utf-8-sig") as f:
            return json.load(f).get("candidates", [])
    except Exception:
        return []


MATCH_HDRS = ["Fit", "Field", "Company", "Role", "Location", "Pay", "Age", "Urgency", "Apply link", "Source"]
FULL_HDRS = ["Company", "Role", "Location", "Posted", "Pay", "Source", "Apply link"]


def append_match_table(ws, row, matches, label):
    """Write a run's match table starting at `row`. Returns next free row."""
    if not matches:
        return row
    cell = ws.cell(row=row, column=1,
                   value=f"{label}  -  Matches (new relevant jobs)")
    cell.font = RUN_FONT
    cell.fill = RUN_FILL
    row += 1
    ws.cell(row=row, column=1, value=("The jobs this run found that fit your "
                                      "profile, with fit score, pay, how fresh, and urgency."))
    ws.cell(row=row, column=1).font = Font(italic=True, size=9, color="808080")
    row += 1
    style_header(ws, row, MATCH_HDRS)
    row += 1
    for m in matches:
        write_row(ws, row, [
            m.get("fit_score", ""), m.get("field", ""), m.get("company", ""),
            m.get("title", ""), m.get("location", ""), m.get("pay", ""),
            m.get("age", ""), m.get("urgency", ""), m.get("url", ""),
            m.get("source_site", ""),
        ], MATCH_HDRS)
        if str(m.get("urgency", "")).lower() == "urgent":
            for c in range(1, len(MATCH_HDRS) + 1):
                ws.cell(row=row, column=c).fill = URGENT_FILL
        write_link(ws, row, 9, m.get("url", ""))
        ws.cell(row=row, column=1).alignment = CENTER
        ws.cell(row=row, column=8).alignment = CENTER
        row += 1
    return row


def append_full_table(ws, row, candidates, label):
    """Write a run's fuller candidate list starting at `row`. Returns next free row."""
    if not candidates:
        return row
    cell = ws.cell(row=row, column=1,
                   value=f"{label}  -  Full List (all relevant jobs this run)")
    cell.font = RUN_FONT
    cell.fill = RUN_FILL
    row += 1
    ws.cell(row=row, column=1, value=("Every posting that met the relevance "
                                      "filters this run, so you can browse wider than the matches above."))
    ws.cell(row=row, column=1).font = Font(italic=True, size=9, color="808080")
    row += 1
    style_header(ws, row, FULL_HDRS)
    row += 1
    for c in candidates:
        posted = ""
        if c.get("postedAt"):
            posted = c["postedAt"][:10] if isinstance(c["postedAt"], str) else str(c.get("postedAt"))
        pay = ""
        sal = c.get("salary")
        if isinstance(sal, dict):
            lo, hi = sal.get("min"), sal.get("max")
            cur = sal.get("currency", "")
            if lo and hi:
                pay = f"{lo}-{hi} {cur}".strip()
            elif lo:
                pay = f"{lo} {cur}".strip()
        write_row(ws, row, [
            c.get("company", ""), c.get("role", ""), c.get("location", ""),
            posted, pay, c.get("source", ""), c.get("url", ""),
        ], FULL_HDRS)
        write_link(ws, row, 7, c.get("url", ""))
        row += 1
    return row


def main():
    now = local_now()
    label = run_label or now.strftime("%H:%M")
    name = day_name(now)
    matches = read_matches()
    candidates = read_candidates()

    if os.path.exists(out_xlsx):
        wb = load_workbook(out_xlsx)
    else:
        wb = Workbook()

    # Get (or create) today's sheet.
    if name in wb.sheetnames:
        ws = wb[name]
    else:
        # Reuse the default empty "Sheet" as today's sheet so fresh files
        # don't carry a leftover blank tab; otherwise create a new one.
        if len(wb.sheetnames) == 1 and wb.sheetnames[0] == "Sheet" and (wb["Sheet"].max_row or 0) <= 1:
            ws = wb["Sheet"]
            ws.title = name
        else:
            ws = wb.create_sheet(name)

    # Determine the first empty row (after any existing content).
    # A blank sheet reports max_row=1; we then start tables at row 1.
    row = 1 if ws.max_row <= 1 else ws.max_row + 1

    # Write this run's two stacked tables.
    row = append_match_table(ws, row, matches, label)
    row = append_full_table(ws, row, candidates, label)

    # Leave a blank spacer row between runs so tables stay visually separate.
    ws.cell(row=row, column=1, value="")

    out = Path(out_xlsx)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    print(f"xlsx updated: {out}  sheet={name} run={label} matches={len(matches)} candidates={len(candidates)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
