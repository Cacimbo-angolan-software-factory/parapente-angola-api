-- Keep unpublished offers, stock and customer contacts outside PostgREST's public schema.
CREATE SCHEMA IF NOT EXISTS platform_commerce;
REVOKE ALL ON SCHEMA platform_commerce FROM PUBLIC, web_anon, web_service;

CREATE TABLE platform_commerce.course_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  show_price_table boolean NOT NULL DEFAULT false
);
INSERT INTO platform_commerce.course_settings DEFAULT VALUES;

CREATE TABLE platform_commerce.course_offers (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) <= 120),
  description text NOT NULL CHECK (char_length(description) <= 2000),
  price_minor bigint CHECK (price_minor BETWEEN 0 AND 99999999999),
  per_lesson boolean NOT NULL DEFAULT false,
  images text[] NOT NULL DEFAULT '{}' CHECK (cardinality(images) <= 5),
  visible boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 9999)
);

CREATE TABLE platform_commerce.shop_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (char_length(description) <= 2000),
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 80),
  price_minor bigint NOT NULL CHECK (price_minor BETWEEN 1 AND 99999999999),
  images text[] NOT NULL DEFAULT '{}' CHECK (cardinality(images) <= 5),
  stock integer NOT NULL CHECK (stock BETWEEN 0 AND 1000000),
  visible boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX shop_visible_products ON platform_commerce.shop_products (name,id) WHERE visible;

CREATE TABLE platform_commerce.shop_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 120),
  customer_phone text NOT NULL CHECK (customer_phone ~ '^\+?[0-9]{8,15}$'),
  customer_email text NOT NULL CHECK (char_length(customer_email) <= 254),
  notes text NOT NULL CHECK (char_length(notes) <= 500),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','paid','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shop_orders_status_date ON platform_commerce.shop_orders (status,created_at DESC,id);
CREATE INDEX shop_orders_date ON platform_commerce.shop_orders (created_at DESC,id);
CREATE INDEX shop_orders_contact_date ON platform_commerce.shop_orders (customer_phone,created_at DESC);
