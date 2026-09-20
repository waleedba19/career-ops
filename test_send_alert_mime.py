#!/usr/bin/env python3
"""Phase 3: verify send_alert builds a correct MIME message.

The attachment must NOT be nested inside multipart/alternative. Expect an outer
multipart/mixed wrapping an inner multipart/alternative (plain + HTML) with the
workbook as a sibling. Mocks SMTP so no network/credentials are used.
Run:  python test_send_alert_mime.py
"""
import os
import sys
import types
import tempfile
import importlib.util
from pathlib import Path
from email import message_from_bytes

ROOT = Path(__file__).parent

# --- Build a fake environment ---
tmp = Path(tempfile.mkdtemp(prefix="co_alert_"))
email_md = tmp / "alert-email.md"
tg_txt = tmp / "alert-telegram.txt"
xlsx = tmp / "matches.xlsx"
email_md.write_text("# Test\nHello [link](https://example.com)\n", encoding="utf-8")
tg_txt.write_text("Test TG body", encoding="utf-8")
xlsx.write_bytes(b"PK\x03\x04 fake workbook bytes")

os.environ.update({
    "SMTP_USER": "me@example.com",
    "SMTP_PASS": "secret",
    "SMTP_TO": "you@example.com",
    "TG_BOT_TOKEN": "",            # skip Telegram so we only exercise email MIME
    "TG_CHAT_ID": "",
    "ALERT_EMAIL": str(email_md),
    "ALERT_TG": str(tg_txt),
    "ALERT_XLSX": str(xlsx),
})

# --- Mock SMTP_SSL to capture the message instead of sending ---
captured = {}
class FakeSMTP:
    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def login(self, u, p): captured["login"] = (u, p)
    def send_message(self, msg): captured["msg"] = msg

import smtplib
smtplib.SMTP_SSL = FakeSMTP

# --- Load send_alert.py as a module and run it ---
sys.argv = ["send_alert.py", "3"]
spec = importlib.util.spec_from_file_location("send_alert", ROOT / "send_alert.py")
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
except SystemExit as e:
    pass  # send_alert calls sys.exit at the end

failures = []
def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)

msg = captured.get("msg")
check("message was sent", msg is not None)
if msg:
    check("outer is multipart/mixed", msg.get_content_type() == "multipart/mixed")
    types = [p.get_content_type() for p in msg.get_payload()]
    check("has inner multipart/alternative", "multipart/alternative" in types)
    check("has xlsx attachment as sibling", any("spreadsheetml" in t for t in types))
    # inner alternative holds plain + html
    alt = next((p for p in msg.get_payload() if p.get_content_type() == "multipart/alternative"), None)
    if alt is not None:
        inner = [p.get_content_type() for p in alt.get_payload()]
        check("alternative holds text/plain + text/html", "text/plain" in inner and "text/html" in inner)
        check("no attachment nested inside alternative", not any("spreadsheetml" in t for t in inner))

import shutil
shutil.rmtree(tmp, ignore_errors=True)
print("\n" + ("ALL PASS" if not failures else f"{len(failures)} FAILURES: {failures}"))
sys.exit(1 if failures else 0)
