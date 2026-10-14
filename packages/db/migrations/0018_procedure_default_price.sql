BEGIN;

-- Optional list price used to prefill treatment plan items; NULL means no default.
ALTER TABLE public.procedures_catalog
  ADD COLUMN IF NOT EXISTS default_price numeric(10,2);

ALTER TABLE public.procedures_catalog
  DROP CONSTRAINT IF EXISTS procedures_catalog_default_price_nonnegative;
ALTER TABLE public.procedures_catalog
  ADD CONSTRAINT procedures_catalog_default_price_nonnegative CHECK (default_price >= 0);

COMMIT;
