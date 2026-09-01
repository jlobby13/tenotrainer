"""
TenoTrainer — User Access Control

Role-based permission helpers for scheduling and session-spacing rules.

Role values stored in users.role:
  "patient"    — default; subject to all clinical session-spacing rules
  "clinician"  — can override session-spacing and weekly session cap
  "supervisor" — full clinician privileges + supervisor dashboard access
  "admin"      — full system access
"""


# ---------------------------------------------------------------------------
# Role constants
# ---------------------------------------------------------------------------

class UserRole:
    PATIENT = "patient"
    CLINICIAN = "clinician"
    ADMIN = "admin"
    SUPERVISOR = "supervisor"


# ---------------------------------------------------------------------------
# Role helpers
# ---------------------------------------------------------------------------

def get_role(user: dict) -> str:
    """Return the user's role string, defaulting to 'patient'."""
    return (user.get("role") or UserRole.PATIENT).lower()


def is_clinician(user: dict) -> bool:
    """Returns True if the user has clinician-level access (clinician, supervisor, or admin)."""
    return get_role(user) in (UserRole.CLINICIAN, UserRole.ADMIN, UserRole.SUPERVISOR)


def is_supervisor(user: dict) -> bool:
    """Returns True if the user has supervisor-level access."""
    return get_role(user) == UserRole.SUPERVISOR


def is_admin(user: dict) -> bool:
    """Returns True if the user has admin-level access."""
    return get_role(user) == UserRole.ADMIN


# ---------------------------------------------------------------------------
# Permission gates
# ---------------------------------------------------------------------------

def can_override_session_spacing(user: dict) -> bool:
    """
    Whether the user may schedule or perform sessions on consecutive days.

    Patients are restricted to an every-other-day pattern (max 4/week) to
    allow tendon remodelling. Clinician-level accounts may override this
    where clinically indicated.
    """
    return is_clinician(user)


def can_exceed_weekly_session_cap(user: dict) -> bool:
    """
    Whether the user may be scheduled for more than 4 sessions/week.

    Patient cap: 4 sessions (Mon/Wed/Fri/Sun pattern).
    Clinician-level accounts may exceed this where evidence supports it.
    """
    return is_clinician(user)


def get_max_weekly_sessions(user: dict) -> int:
    """
    Return the maximum permitted sessions per week for this user.
    Clinicians may set higher frequencies; patients are capped at 4.
    """
    return 7 if can_exceed_weekly_session_cap(user) else 4
