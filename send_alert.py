#!/usr/bin/env python3
"""send_alert.py — sends the alert that generate-alert.mjs produced.
Uses only the Python stdlib (smtplib for Gmail, urllib for Telegram) which has
been verified working. Reads:
  /tmp/alert-email.md     (markdown email body)
  /tmp/alert-telegram.txt (plain text)
  matches.xlsx            (attached via ALERT_XLSX)
Env: SMTP_USER, SMTP_PASS, SMTP_TO, TG_BOT_TOKEN, TG_CHAT_ID, ALERT_XLSX
Usage: python send_alert.py <count>
"""
import json
import os
import smtplib
import sys
import urllib.request
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
from pathlib import Path

count = sys.argv[1] if len(sys.argv) > 1 else "?"
force_send = "--force" in sys.argv          # bypass "only when new" gating (delivery test)
test_mode = os.environ.get("TEST_MODE", "") == "1" or "--test" in sys.argv
email_path = os.environ.get("ALERT_EMAIL", "/tmp/alert-email.md")
tg_path = os.environ.get("ALERT_TG", "/tmp/alert-telegram.txt")
xlsx_env = os.environ.get("ALERT_XLSX", "")
# In test/force mode the alert bodies may not have been generated — fall back
# to a simple built-in body so the delivery path itself is exercised.
if (test_mode or force_send):
    if not Path(email_path).exists():
        email_path = ""  # signal to use fallback
    if not Path(tg_path).exists():
        tg_path = ""

results = []

# ---- Email via smtplib (Gmail 465 SSL) ----
if os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS") and os.environ.get("SMTP_TO"):
    try:
        md = Path(email_path).read_text(encoding="utf-8") if email_path else "CareerOps delivery test — the email path works."
        # Build a simple HTML body (basic markdown -> <br> lines, links clickable).
        import re
        def htmlize(md):
            out = md
            # STRONG MATCH sentinels (from generate-alert.mjs) -> red highlight
            # so genuinely high-fit roles pop in the HTML email.
            out = out.replace("⟪STRONG⟫", '<span style="color:#c0392b;font-weight:bold">')
            out = out.replace("⟪/STRONG⟫", "</span>")
            out = re.sub(r"^#+ (.*)$", r"<h1>\1</h1>", out, flags=re.M)
            out = re.sub(r"^## (.*)$", r"<h2>\1</h2>", out, flags=re.M)
            out = re.sub(r"\[(.+?)\]\((https?://\S+?)\)", r'<a href="\2">\1</a>', out)
            out = out.replace("***", "<b>").replace("**", "<b>")
            return out.replace("\n", "<br/>")
        # MIME structure: the xlsx attachment must NOT be nested inside
        # multipart/alternative (which is for alternative body representations
        # only). Use an outer multipart/mixed containing an inner
        # multipart/alternative (plain + HTML) plus the workbook as a sibling.
        # Some clients drop/misrender the body when the attachment is nested
        # inside "alternative".
        msg = MIMEMultipart("mixed")
        alt = MIMEMultipart("alternative")
        if count == "0":
            subject = "CareerOps: your daily job update (no new matches today)"
        else:
            subject = f"CareerOps: {count} new remote job match(es)"
        if test_mode:
            subject = "[TEST] " + subject
        msg["Subject"] = subject
        msg["From"] = os.environ["SMTP_USER"]
        msg["To"] = os.environ["SMTP_TO"]
        if test_mode:
            md = "THIS IS A TEST MESSAGE FROM CAREEROPS - not a real job alert.\n\n" + md
        alt.attach(MIMEText(md, "plain", "utf-8"))
        alt.attach(MIMEText(htmlize(md), "html", "utf-8"))
        msg.attach(alt)
        # Attach the Excel workbook (matches + full list) if present.
        xlsx_path = os.environ.get("ALERT_XLSX")
        if xlsx_path and Path(xlsx_path).exists():
            part = MIMEBase("application", "vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            part.set_payload(Path(xlsx_path).read_bytes())
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment; filename=career-matches.xlsx")
            msg.attach(part)
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
            s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
            s.send_message(msg)
        results.append("email: OK")
    except Exception as e:
        results.append(f"email: FAIL {e}")
else:
    results.append("email: skipped (no SMTP creds)")

# ---- Telegram via urllib ----
if os.environ.get("TG_BOT_TOKEN") and os.environ.get("TG_CHAT_ID"):
    try:
        text = Path(tg_path).read_text(encoding="utf-8") if tg_path else "CareerOps delivery test — the Telegram path works."
        if test_mode:
            text = "THIS IS A TEST MESSAGE FROM CAREEROPS - not a real job alert.\n\n" + text
        data = json.dumps({
            "chat_id": os.environ["TG_CHAT_ID"],
            "text": text,
            "disable_web_page_preview": False,
        }).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{os.environ['TG_BOT_TOKEN']}/sendMessage",
            data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            code = r.status
        results.append(f"telegram: OK ({code})")
    except Exception as e:
        results.append(f"telegram: FAIL {e}")
else:
    results.append("telegram: skipped (no TG creds)")

print("\n".join(results))
sys.exit(0 if all("OK" in r or "skipped" in r for r in results) else 1)
