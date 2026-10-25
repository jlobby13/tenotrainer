-- =============================================================================
-- M2 — patient invitation type (enum value only).
--
-- PostgreSQL forbids USING a newly added enum value in the transaction that
-- added it ("unsafe use of new value"). The main M2 migration
-- (20261025000001_m2_native_onboarding_assignment.sql) references 'PATIENT'
-- in constraints and functions, so the value is added here, alone, and is
-- committed before that migration runs.
-- =============================================================================
ALTER TYPE invitation_type ADD VALUE IF NOT EXISTS 'PATIENT';
