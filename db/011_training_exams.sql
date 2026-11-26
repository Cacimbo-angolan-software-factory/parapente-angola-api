-- Gateway-only: neither the public profile nor the generic REST adapter reads this schema.
CREATE SCHEMA IF NOT EXISTS training_private;
REVOKE ALL ON SCHEMA training_private FROM PUBLIC, web_anon, web_service;

CREATE TABLE training_private.exam_versions (
  exam_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  exam jsonb NOT NULL,
  rubric jsonb NOT NULL,
  PRIMARY KEY (exam_id, version)
);

CREATE TABLE training_private.exam_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  exam_id text NOT NULL,
  version integer NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  published_at timestamptz,
  published_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','draft','submitted','published')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  answers jsonb NOT NULL DEFAULT '{}',
  auto_score numeric,
  marks jsonb,
  result jsonb,
  UNIQUE (pilot_id, exam_id, attempt_number),
  FOREIGN KEY (exam_id, version) REFERENCES training_private.exam_versions(exam_id, version)
);

CREATE UNIQUE INDEX exam_one_unpublished ON training_private.exam_attempts(pilot_id, exam_id)
  WHERE status <> 'published';
CREATE INDEX exam_pilot_history ON training_private.exam_attempts(pilot_id, assigned_at DESC);

-- Keep request identities even when two different allocation requests resolve to the same open attempt.
CREATE TABLE training_private.exam_assignments (
  requested_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL REFERENCES training_private.exam_attempts(id) ON DELETE CASCADE,
  PRIMARY KEY (requested_by, request_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA training_private FROM PUBLIC, web_anon, web_service;
