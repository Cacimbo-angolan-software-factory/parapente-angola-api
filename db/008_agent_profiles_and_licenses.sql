ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS company_nif text,
  ADD COLUMN IF NOT EXISTS company_address text,
  ADD COLUMN IF NOT EXISTS company_phone text,
  ADD COLUMN IF NOT EXISTS company_email text,
  ADD COLUMN IF NOT EXISTS company_logo_url text;

ALTER TABLE public.licencas
  ADD COLUMN IF NOT EXISTS license_type text NOT NULL DEFAULT 'pilot';

ALTER TABLE public.licencas DROP CONSTRAINT IF EXISTS licencas_license_type_check;
ALTER TABLE public.licencas
  ADD CONSTRAINT licencas_license_type_check CHECK (license_type IN ('pilot', 'agent'));

CREATE INDEX IF NOT EXISTS licencas_holder_type_idx
  ON public.licencas(piloto_id, license_type, data_validade DESC);

-- Renewals preserve the licence number and add a dated history row. The recovered
-- unique index contradicted that existing workflow and made every renewal fail.
DROP INDEX IF EXISTS public.licencas_numero_licenca_key;
CREATE INDEX IF NOT EXISTS licencas_numero_licenca_idx ON public.licencas(numero_licenca);

DROP FUNCTION IF EXISTS public.get_all_users_with_details();
CREATE FUNCTION public.get_all_users_with_details()
RETURNS TABLE(
  id uuid,name text,email text,role text,nif text,status text,level text,flight_hours integer,
  license_validity date,face_photo_url text,verified boolean,company_name text,company_nif text,
  company_address text,company_phone text,company_email text,company_logo_url text,
  agent_license_number integer,agent_license_validity date
)
LANGUAGE sql STABLE AS $$
  SELECT p.id,p.name,u.email,p.role,p.nif,p.status,p.level,p.flight_hours,p.license_validity,
    p.face_photo_url,p.verified,p.company_name,p.company_nif,p.company_address,p.company_phone,
    p.company_email,p.company_logo_url,agent_license.numero_licenca,agent_license.data_validade
  FROM public.profiles p
  JOIN public.platform_users u ON u.id=p.id
  LEFT JOIN LATERAL (
    SELECT l.numero_licenca,l.data_validade
    FROM public.licencas l
    WHERE l.piloto_id=p.id AND l.license_type='agent'
    ORDER BY l.data_validade DESC,l.created_at DESC LIMIT 1
  ) agent_license ON true;
$$;

GRANT EXECUTE ON FUNCTION public.get_all_users_with_details() TO web_service;
