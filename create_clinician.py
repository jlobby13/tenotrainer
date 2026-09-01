"""
Provision a clinician account.

A clinician has patient-facing UI access plus scheduling overrides:
  - can log sessions on consecutive days
  - can exceed the 4-session/week cap
  - does NOT have supervisor dashboard access

Usage:
    python create_clinician.py [email] [name] [password]

If arguments are omitted, the defaults below are used.
"""
import asyncio
import secrets
import bcrypt
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from app.db.database import get_db, init_db

EMAIL    = sys.argv[1] if len(sys.argv) > 1 else "clinician@example.com"
NAME     = sys.argv[2] if len(sys.argv) > 2 else "Clinician"
PASSWORD = sys.argv[3] if len(sys.argv) > 3 else "changeme"


async def create():
    await init_db()
    password_hash = bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt()).decode()
    token = secrets.token_urlsafe(32)

    db = await get_db()
    try:
        cur = await db.execute("SELECT id, role FROM users WHERE email = ?", (EMAIL.lower(),))
        row = await cur.fetchone()
        if row:
            await db.execute(
                "UPDATE users SET role = 'clinician', password_hash = ?, name = ?, session_token = ? WHERE id = ?",
                (password_hash, NAME, token, row[0]),
            )
            await db.commit()
            print(f"Updated existing user (id={row[0]}) to clinician role.")
        else:
            cur = await db.execute(
                "INSERT INTO users (name, email, password_hash, role, session_token) VALUES (?, ?, ?, ?, ?)",
                (NAME, EMAIL.lower(), password_hash, "clinician", token),
            )
            await db.commit()
            user_id = cur.lastrowid
            print(f"Created clinician account: {EMAIL} (id={user_id})")

        print(f"\nLogin: {EMAIL} / {PASSWORD}")
        print("URL: http://localhost:8000/login")
        print("\nPrivileges: consecutive-day sessions, >4 sessions/week, patient-facing UI only.")
        print("For supervisor dashboard access, use create_supervisor.py instead.")
    finally:
        await db.close()


asyncio.run(create())
