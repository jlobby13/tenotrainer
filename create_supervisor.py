"""
One-time script to create the supervisor account.
Run with: python create_supervisor.py
"""
import asyncio
import secrets
import bcrypt
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from app.db.database import get_db, init_db

EMAIL = "jasonlobdell.pt@gmail.com"
NAME  = "Jason Lobdell"
PASSWORD = "1234"


async def create():
    await init_db()
    password_hash = bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt()).decode()
    token = secrets.token_urlsafe(32)

    db = await get_db()
    try:
        # Check if already exists
        cur = await db.execute("SELECT id, role FROM users WHERE email = ?", (EMAIL.lower(),))
        row = await cur.fetchone()
        if row:
            # Update existing user to supervisor
            await db.execute(
                "UPDATE users SET role = 'supervisor', password_hash = ?, name = ?, session_token = ? WHERE id = ?",
                (password_hash, NAME, token, row[0]),
            )
            await db.commit()
            print(f"Updated existing user (id={row[0]}) to supervisor role.")
        else:
            cur = await db.execute(
                "INSERT INTO users (name, email, password_hash, role, session_token) VALUES (?, ?, ?, ?, ?)",
                (NAME, EMAIL.lower(), password_hash, "supervisor", token),
            )
            await db.commit()
            user_id = cur.lastrowid
            print(f"Created supervisor account: {EMAIL} (id={user_id})")

        # Assign all existing patients to this supervisor
        cur = await db.execute("SELECT id FROM users WHERE role = 'supervisor' AND email = ?", (EMAIL.lower(),))
        sup_row = await cur.fetchone()
        sup_id = sup_row[0]

        cur = await db.execute("SELECT id FROM users WHERE role = 'patient' AND password_hash IS NOT NULL")
        patients = await cur.fetchall()
        assigned = 0
        for p in patients:
            try:
                await db.execute(
                    "INSERT OR IGNORE INTO supervisor_patients (supervisor_id, patient_id) VALUES (?, ?)",
                    (sup_id, p[0]),
                )
                assigned += 1
            except Exception:
                pass
        await db.commit()
        print(f"Assigned {assigned} patient(s) to supervisor.")
        print(f"\nLogin: {EMAIL} / {PASSWORD}")
        print(f"URL: http://localhost:8000/login")
    finally:
        await db.close()


asyncio.run(create())
