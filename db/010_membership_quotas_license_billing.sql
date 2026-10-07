CREATE TABLE IF NOT EXISTS public.license_fee_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    license_type text NOT NULL,
    name text NOT NULL,
    amount numeric(14,2) NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'AOA',
    active boolean NOT NULL DEFAULT true,
    effective_from date NOT NULL DEFAULT CURRENT_DATE,
    effective_to date,
    notes text,
    created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT license_fee_rules_type_check CHECK (license_type IN ('pilot', 'agent')),
    CONSTRAINT license_fee_rules_amount_check CHECK (amount >= 0),
    CONSTRAINT license_fee_rules_dates_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT license_fee_rules_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS license_fee_rules_lookup_idx
    ON public.license_fee_rules (license_type, active, effective_from DESC);

CREATE TABLE IF NOT EXISTS public.membership_quotas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    period_year integer NOT NULL,
    amount_due numeric(14,2) NOT NULL DEFAULT 0,
    amount_paid numeric(14,2) NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'AOA',
    due_date date NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    payment_method_id uuid REFERENCES public.payment_methods(id),
    paid_at timestamptz,
    notes text,
    created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT membership_quotas_pkey PRIMARY KEY (id),
    CONSTRAINT membership_quotas_year_check CHECK (period_year BETWEEN 2000 AND 2200),
    CONSTRAINT membership_quotas_amount_check CHECK (amount_due >= 0 AND amount_paid >= 0 AND amount_paid <= amount_due),
    CONSTRAINT membership_quotas_status_check CHECK (status IN ('pending', 'partial', 'paid', 'overdue', 'waived')),
    CONSTRAINT membership_quotas_unique_period UNIQUE (member_id, period_year)
);

CREATE INDEX IF NOT EXISTS membership_quotas_member_idx ON public.membership_quotas (member_id, period_year DESC);
CREATE INDEX IF NOT EXISTS membership_quotas_status_idx ON public.membership_quotas (status, due_date);

CREATE TABLE IF NOT EXISTS public.license_renewals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    license_id uuid NOT NULL REFERENCES public.licencas(id),
    new_license_id uuid REFERENCES public.licencas(id),
    member_id uuid NOT NULL REFERENCES public.profiles(id),
    license_type text NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    amount_due numeric(14,2) NOT NULL DEFAULT 0,
    amount_paid numeric(14,2) NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'AOA',
    status text NOT NULL DEFAULT 'pending',
    payment_method_id uuid REFERENCES public.payment_methods(id),
    paid_at timestamptz,
    notes text,
    created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT license_renewals_pkey PRIMARY KEY (id),
    CONSTRAINT license_renewals_type_check CHECK (license_type IN ('pilot', 'agent')),
    CONSTRAINT license_renewals_dates_check CHECK (period_end >= period_start),
    CONSTRAINT license_renewals_amount_check CHECK (amount_due >= 0 AND amount_paid >= 0 AND amount_paid <= amount_due),
    CONSTRAINT license_renewals_status_check CHECK (status IN ('pending', 'paid', 'cancelled', 'waived'))
);

CREATE INDEX IF NOT EXISTS license_renewals_member_idx ON public.license_renewals (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS license_renewals_status_idx ON public.license_renewals (status, period_end);

ALTER TABLE public.licencas ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'not_applicable';
ALTER TABLE public.licencas ADD COLUMN IF NOT EXISTS renewal_id uuid REFERENCES public.license_renewals(id);
DO $$ BEGIN
    ALTER TABLE public.licencas ADD CONSTRAINT licencas_billing_status_check CHECK (billing_status IN ('not_applicable', 'pending', 'paid', 'cancelled', 'waived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.license_fee_rules TO web_service;
GRANT SELECT, INSERT, UPDATE ON public.membership_quotas TO web_service;
GRANT SELECT, INSERT, UPDATE ON public.license_renewals TO web_service;
