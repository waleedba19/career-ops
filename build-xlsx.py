#!/usr/bin/env python3
"""build-xlsx.py - turn the scan's matches + relevant candidates into a real
Excel workbook (matches.xlsx) with two sheets:

  Sheet "Matches"   - the day's new high-fit jobs (from /tmp/alert-rows.csv)
  Sheet "Full List" - every relevant posting the scanner saw this run (from
                      data/candidates.json), so you can browse wider than the
                      handful that got a new alert.

Uses openpyxl. Paths via env: MATCHES_CSV, CANDIDATES_JSON, OUT_XLSX.

Writes matches.xlsx to the current dir by default (the runner passes OUT_XLSX).
"""

import csv
import json
import os
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

matches_csv = os.environ.get("MATCHES_CSV", "/tmp/alert-rows.csv")
candidates_json = os.environ.get("CANDIDATES_JSON", "data/candidates.json")
out_xlsx = os.environ.get("OUT_XLSX", "matches.xlsx")

HEADER_FILL = PatternFill("solid", fgColor="1F4E79")
HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
LINK_FONT = Font(color="0563C1", underline="single")
URGENT_FILL = PatternFill("solid", fgColor="FFEB9C")
THIN = Side(style="thin", color="D0D0D0")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(vertical="top", wrap_text=True)


def style_header(ws, ncols):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(vertical="center")
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(ncols)}1"


def write_link(ws, row, col, url, display=None):
    cell = ws.cell(row=row, column=col, value=display or url)
    if url and url.startswith("http"):
        cell.hyperlink = url
        cell.font = LINK_FONT
    return cell


def build_matches(ws):
    rows = []
    if os.path.exists(matches_csv):
        with open(matches_csv, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    headers = ["Fit", "Field", "Company", "Role", "Location", "Pay", "Age", "Urgency", "Apply link", "Source"]
    ws.append(headers)
    for r in rows:
        ws.append([
            r.get("fit_score", ""),
            r.get("field", ""),
            r.get("company", ""),
            r.get("title", ""),
            r.get("location", ""),
            r.get("pay", ""),
            r.get("age", ""),
            r.get("urgency", ""),
            r.get("url", ""),
            r.get("source_site", ""),
        ])
    style_header(ws, len(headers))
    # Wrap text + borders + urgency colour + clickable links
    for i, r in enumerate(rows, start=2):
        for c in range(1, len(headers) + 1):
            ws.cell(row=i, column=c).border = BORDER
        ws.cell(row=i, column=1).alignment = Alignment(horizontal="center")
        ws.cell(row=i, column=8).alignment = Alignment(horizontal="center")
        if str(r.get("urgency", "")).lower() == "urgent":
            for c in range(1, len(headers) + 1):
                ws.cell(row=i, column=c).fill = URGENT_FILL
        write_link(ws, i, 9, r.get("url", ""))
    widths = [6, 34, 24, 40, 18, 20, 26, 12, 46, 22]
    for idx, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = w


def build_full_list(ws):
    candidates = []
    if os.path.exists(candidates_json):
        try:
            with open(candidates_json, encoding="utf-8-sig") as f:
                candidates = json.load(f).get("candidates", [])
        except Exception:
            candidates = []
    headers = ["Company", "Role", "Location", "Posted", "Pay", "Source", "Apply link"]
    ws.append(headers)
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
        ws.append([
            c.get("company", ""),
            c.get("role", ""),
            c.get("location", ""),
            posted,
            pay,
            c.get("source", ""),
            c.get("url", ""),
        ])
    style_header(ws, len(headers))
    for i in range(2, len(candidates) + 2):
        for c in range(1, len(headers) + 1):
            ws.cell(row=i, column=c).border = BORDER
        write_link(ws, i, 7, candidates[i - 2].get("url", ""))
    widths = [26, 44, 22, 12, 20, 22, 52]
    for idx, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = w


def main():
    wb = Workbook()
    ws_m = wb.active
    ws_m.title = "Matches"
    build_matches(ws_m)
    ws_f = wb.create_sheet("Full List")
    build_full_list(ws_f)
    out = Path(out_xlsx)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    n_matches = 0
    if os.path.exists(matches_csv):
        with open(matches_csv, newline="", encoding="utf-8") as f:
            n_matches = sum(1 for _ in f) - 1
    print(f"xlsx saved: {out} (Matches={max(n_matches, 0)}, FullList=total)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
