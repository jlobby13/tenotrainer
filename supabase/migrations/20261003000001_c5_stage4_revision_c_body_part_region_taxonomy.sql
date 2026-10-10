-- =============================================================================
-- C5, Stage 4 — Revision C, Part 1-2: populate the EXISTING
-- canonical_exercises.body_part TEXT[] column (present since 20260916000001,
-- unused/NULL for all 47 exercises until now) as the anatomical/functional
-- Region taxonomy for library filtering. No new column added — category,
-- loading_profile, region_bias (Achilles-tendinopathy clinical subtype:
-- midportion/insertional — NOT a body region), and target_tissues remain
-- entirely separate, untouched concepts.
--
-- Approved vocabulary (stable machine values; display labels are a UI-layer
-- concern, not stored here):
--   calf_achilles, foot_ankle, knee, hip, core_trunk,
--   whole_lower_extremity_general
--
-- Multi-tag (TEXT[], OR-within-region-filter semantics at query time).
-- Classified from each exercise's actual target_tissues + name + category —
-- never from incidental joint movement (e.g. "Bent-Knee" exercises name a
-- body POSITION, not a knee TARGET, and are correctly NOT tagged 'knee';
-- see the implementation report for the full per-exercise rationale and the
-- exercises flagged as genuine judgment calls).
-- =============================================================================

ALTER TABLE canonical_exercises
  ADD CONSTRAINT canonical_exercises_body_part_vocabulary CHECK (
    body_part <@ ARRAY['calf_achilles', 'foot_ankle', 'knee', 'hip', 'core_trunk', 'whole_lower_extremity_general']::TEXT[]
  );

-- The great majority of the library: pure calf/Achilles/soleus/gastrocnemius
-- target_tissues, no other region evidence.
UPDATE canonical_exercises SET body_part = ARRAY['calf_achilles']
WHERE legacy_ex_id IN (
  'ex_001','ex_002','ex_003','ex_004','ex_005','ex_006','ex_007','ex_008','ex_009','ex_010',
  'ex_011','ex_012','ex_013','ex_014','ex_015','ex_016','ex_017','ex_018','ex_019','ex_020',
  'ex_021','ex_022','ex_023','ex_024','ex_025','ex_026','ex_027','ex_028','ex_029','ex_030',
  'ex_031','ex_032','ex_035','ex_036','ex_037','ex_041','ex_042','ex_043','ex_044','ex_045','ex_047'
);

-- ex_033/034: target_tissues explicitly name "(entire) posterior chain", not
-- just Achilles/calf tissue — these are whole-limb run-reentry activities,
-- broader than the isolated calf exercises above. Flagged judgment call.
UPDATE canonical_exercises SET body_part = ARRAY['calf_achilles', 'whole_lower_extremity_general']
WHERE legacy_ex_id IN ('ex_033', 'ex_034');

-- ex_038 "Tibialis Posterior Strengthening": target_tissues are "Tibialis
-- posterior, medial arch" — a foot/medial-arch functional target, not calf/
-- Achilles tendon loading (per "tag by meaningful target/use", not muscle
-- origin location).
UPDATE canonical_exercises SET body_part = ARRAY['foot_ankle']
WHERE legacy_ex_id = 'ex_038';

-- ex_039 "Hip Abductor Strengthening": target_tissues are "Gluteus medius,
-- hip abductors" — unambiguous.
UPDATE canonical_exercises SET body_part = ARRAY['hip']
WHERE legacy_ex_id = 'ex_039';

-- ex_040 "Balance and Frontal-Plane Control Drills": target_tissues are
-- "Ankle stabilisers, intrinsic foot muscles, gluteus medius" — names TWO
-- specific regions directly, more precise than a generic "whole lower
-- extremity" catch-all.
UPDATE canonical_exercises SET body_part = ARRAY['foot_ankle', 'hip']
WHERE legacy_ex_id = 'ex_040';

-- ex_046 "Knee-to-Wall WBLT Self-Mobilization": target_tissues include
-- "ankle joint capsule" alongside gastrocnemius/Achilles tendon — a genuine,
-- distinct ankle-joint structure (not incidental movement), justifying the
-- second tag.
UPDATE canonical_exercises SET body_part = ARRAY['calf_achilles', 'foot_ankle']
WHERE legacy_ex_id = 'ex_046';
