"""
TenoTrainer — User Access Control

Shell module for user role and permission management.
Role-based restrictions are stubbed here and will be wired to a full
clinician/patient/admin system in a future release.

Current role values stored in users.role:
  "patient"   — default; subject to all clinical session-spacing rules
  "clinician" — future; can override session-spacing and scheduling rules
  "admin"     — future; full system access
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
    """
    Returns True if the user has clinician-level access.

    STUB — clinician/admin account types are not yet provisioned.
    Always returns False for all current accounts until the full access
    control system is integrated.
    """
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

    Clinical rationale: tendons require a minimum of 48 hours between
    loading sessions for adaptive remodelling. Patient accounts are
    restricted to an every-other-day pattern (max 4 sessions/week).
    Clinician accounts may override this where clinically indicated.

    STUB — always returns False until clinician accounts are provisioned.
    """
    return is_clinician(user)


def can_exceed_weekly_session_cap(user: dict) -> bool:
    """
    Whether the user may be scheduled for more than 4 sessions/week.

    Patient cap: 4 sessions (Mon/Wed/Fri/Sun every-other-day pattern).
    Clinician override: permitted where evidence supports higher frequency.

    STUB — always returns False until clinician accounts are provisioned.
    """
    return is_clinician(user)


def get_max_weekly_sessions(user: dict) -> int:
    """
    Return the maximum permitted sessions per week for this user.
    Clinicians may set higher frequencies; patients are capped at 4.
    """
    return 7 if can_exceed_weekly_session_cap(user) else 4
