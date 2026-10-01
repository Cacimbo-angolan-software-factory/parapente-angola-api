-- Agent operations, client ownership and immutable commission snapshots.

CREATE OR REPLACE FUNCTION public.sync_platform_user_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE platform_users
  SET role = CASE lower(COALESCE(NEW.role, 'client'))
    WHEN 'admin' THEN 'admin'
    WHEN 'pilot' THEN 'pilot'
    WHEN 'provider' THEN 'provider'
    WHEN 'agent' THEN 'agent'
    WHEN 'student' THEN 'student'
    WHEN 'aluno' THEN 'aluno'
    ELSE 'client'
  END,
  updated_at = now()
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS activity_id uuid REFERENCES public.activities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bookings_agent_id_idx ON public.bookings(agent_id);
CREATE INDEX IF NOT EXISTS bookings_activity_id_idx ON public.bookings(activity_id);

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS receipts_agent_id_idx ON public.receipts(agent_id);

CREATE TABLE IF NOT EXISTS public.agent_clients (
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, client_id),
  UNIQUE (client_id),
  CHECK (agent_id <> client_id)
);

CREATE INDEX IF NOT EXISTS agent_clients_agent_id_idx ON public.agent_clients(agent_id);

CREATE TABLE IF NOT EXISTS public.agent_commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('default', 'location', 'activity')),
  scope_id uuid,
  calculation_type text NOT NULL CHECK (calculation_type IN ('percentage', 'fixed')),
  commission_value numeric(12,2) NOT NULL CHECK (commission_value >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope_type = 'default' AND scope_id IS NULL)
    OR (scope_type IN ('location', 'activity') AND scope_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_commission_rules_unique_scope
  ON public.agent_commission_rules(agent_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS public.agent_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES public.bookings(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.agent_commission_rules(id) ON DELETE SET NULL,
  base_amount numeric(12,2) NOT NULL DEFAULT 0,
  calculation_type text NOT NULL CHECK (calculation_type IN ('percentage', 'fixed')),
  commission_value numeric(12,2) NOT NULL CHECK (commission_value >= 0),
  commission_amount numeric(12,2) NOT NULL CHECK (commission_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_commissions_agent_id_idx ON public.agent_commissions(agent_id);

CREATE OR REPLACE FUNCTION public.snapshot_agent_commission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_rule public.agent_commission_rules%ROWTYPE;
  calculated_amount numeric(12,2);
BEGIN
  IF NEW.agent_id IS NULL OR NEW.status = 'cancelled' THEN
    DELETE FROM public.agent_commissions WHERE booking_id = NEW.id;
    RETURN NEW;
  END IF;

  SELECT rule.* INTO selected_rule
  FROM public.agent_commission_rules rule
  WHERE rule.agent_id = NEW.agent_id
    AND rule.is_active
    AND (
      (rule.scope_type = 'activity' AND rule.scope_id = NEW.activity_id)
      OR (rule.scope_type = 'location' AND rule.scope_id = NEW.location_id)
      OR rule.scope_type = 'default'
    )
  ORDER BY CASE rule.scope_type WHEN 'activity' THEN 1 WHEN 'location' THEN 2 ELSE 3 END
  LIMIT 1;

  IF selected_rule.id IS NULL THEN
    DELETE FROM public.agent_commissions WHERE booking_id = NEW.id;
    RETURN NEW;
  END IF;

  calculated_amount := CASE selected_rule.calculation_type
    WHEN 'percentage' THEN ROUND(COALESCE(NEW.total_price, 0) * selected_rule.commission_value / 100, 2)
    ELSE selected_rule.commission_value
  END;

  INSERT INTO public.agent_commissions (
    booking_id, agent_id, rule_id, base_amount, calculation_type,
    commission_value, commission_amount, updated_at
  ) VALUES (
    NEW.id, NEW.agent_id, selected_rule.id, COALESCE(NEW.total_price, 0),
    selected_rule.calculation_type, selected_rule.commission_value,
    calculated_amount, now()
  )
  ON CONFLICT (booking_id) DO UPDATE SET
    agent_id = EXCLUDED.agent_id,
    rule_id = EXCLUDED.rule_id,
    base_amount = EXCLUDED.base_amount,
    calculation_type = EXCLUDED.calculation_type,
    commission_value = EXCLUDED.commission_value,
    commission_amount = EXCLUDED.commission_amount,
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS snapshot_agent_commission_trigger ON public.bookings;
CREATE TRIGGER snapshot_agent_commission_trigger
AFTER INSERT OR UPDATE OF agent_id, location_id, activity_id, total_price, status
ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.snapshot_agent_commission();

GRANT ALL ON public.agent_clients, public.agent_commission_rules, public.agent_commissions TO web_service;
