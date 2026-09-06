-- Closes a race window in the finalize route: two near-simultaneous finalize
-- retries could otherwise both observe "no evaluation exists yet" and both
-- insert one. A blanket UNIQUE(rehab_session_id) would prevent that but
-- would also block the explicitly-intended future behavior of a new
-- rule_version producing a NEW evaluation row without rewriting history
-- (see tolerance_evaluations' original Stage 1 migration comment) — so the
-- uniqueness is scoped to (rehab_session_id, rule_version) instead: at most
-- one evaluation per session per rule version, ever, but a future version
-- bump can still add a new row alongside the old one.
ALTER TABLE tolerance_evaluations
  ADD CONSTRAINT tolerance_evaluations_session_rule_version_unique
  UNIQUE (rehab_session_id, rule_version);
