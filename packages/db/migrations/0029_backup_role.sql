-- Automatic nightly backup: read-only backup role, backup run log and the owner's "Son yedek" status. Safe to re-run.
--
-- A nightly GitHub Actions job in the owner's PRIVATE repository 'dentos-yedek' connects as dentos_backup through the
-- Supavisor session pooler (IPv4), runs pg_dump of schema public (and the data of auth.users / auth.identities when this
-- role can read them), verifies and encrypts the dump (age) and finally calls public.backup_heartbeat(size, sha256,
-- toc). The owner's export page (/settings/export) shows the latest run through public.backup_status(). One DB-wide
-- backup: nothing here is per clinic.
--
--  1. Preflight: run as postgres (Supabase SQL editor); postgres must hold CREATEROLE and BYPASSRLS (PostgreSQL 16+:
--     only a BYPASSRLS role may create a BYPASSRLS role; 15 and older: superuser only); pgcrypto reachable
--     (gen_random_bytes, hmac); 0019 helpers (current_app_role, auth.uid); roles anon / authenticated / service_role;
--     an existing backup_runs must already have the shape created below.
--  2. Role dentos_backup: LOGIN NOINHERIT BYPASSRLS CONNECTION LIMIT 2, no other attribute, member of no role;
--     role settings default_transaction_read_only = on, statement_timeout = 10min,
--     idle_in_transaction_session_timeout = 10min. BYPASSRLS is required: pg_dump turns row security off and stops
--     with an error on any RLS table the role cannot bypass (a partial dump is never produced).
--     Password: 32 random bytes (hex) from gen_random_bytes, generated only when the role is created or when the flag
--     dentos.backup_rotate_password is 'on' (first statement after BEGIN). The role gets a SCRAM-SHA-256 verifier
--     computed here (RFC 5802 / 7677, checked against the RFC 7677 vector), so the clear-text password never appears in
--     any statement text (server log, pg_stat_statements); it is kept in a session temp table and shown ONCE by the
--     last statement of this file, which also empties that table.
--  3. Privileges of dentos_backup: USAGE on schema public; REVOKE ALL then SELECT on every table, view and sequence in
--     public (no INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER / MAINTAIN, no sequence USAGE / UPDATE);
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres for tables and sequences created later; EXECUTE only on
--     public.backup_heartbeat. USAGE on schema auth + SELECT on auth.users / auth.identities is attempted in a
--     sub-block: Supabase may not let postgres grant it (a GRANT without grant option only warns), so the result is
--     read back with has_*_privilege and reported, never assumed. Without it the nightly job backs up public only.
--  4. public.backup_runs (id, ran_at, size_bytes, sha256, toc_entries, note): RLS on, no policies, no privileges for
--     anon / authenticated / service_role. Written only by backup_heartbeat, which keeps the newest 400 rows.
--  5. public.backup_heartbeat(bigint, text, integer): SECURITY DEFINER, validates its inputs, EXECUTE for dentos_backup
--     only. The caller's session is read-only by default, so the job calls it inside BEGIN READ WRITE.
--     public.backup_status(): SECURITY DEFINER, STABLE, clinic owner only (current_app_role() = 'owner', 0019); returns
--     {ok, last: {ran_at, size_bytes, toc_entries} | null, now}. EXECUTE for authenticated only.
--  6. Self-checks (any RAISE rolls everything back): role attributes / settings / memberships, read-only privilege
--     matrix over every relation in public, function ACLs, RLS without policies, and a rolled-back replay of
--     backup_heartbeat (validation, 400-row retention) and backup_status (editor and non-owner refused, owner served,
--     impersonated through request.jwt.claims like 0027).
--
-- Error contract (as 0020-0027): RAISE USING MESSAGE = <Turkish text>, ERRCODE = 42501 (403) or 22023 (400),
-- HINT = key (BACKUP_*).
--
-- RUNBOOK (production is the only database):
--   1. SQL editor → New query → paste this file ALONE → Run (confirm the "destructive operation" prompt: the only
--      DELETE empties this session's temp result table). One transaction; any self-check failure rolls everything back.
--   2. The result grid (last statement) shows four rows. Copy the "Şifre" value NOW into the private repository
--      dentos-yedek: Settings → Secrets and variables → Actions → New repository secret, name
--      DENTOS_BACKUP_DB_PASSWORD. It is not stored anywhere else and is never shown again. Row "Giriş hesapları"
--      says whether auth.users / auth.identities will be in the backup.
--   3. Run the 'Gece yedeği' workflow once by hand (dentos-yedek → Actions → Gece yedeği → Run workflow); the export
--      page then shows "Otomatik yedek: son yedek … önce".
--   Lost password / suspected leak: change 'off' to 'on' in the dentos.backup_rotate_password line below, run the file
--   again, update the secret. Re-running with 'off' changes no password (re-asserts attributes, grants, functions).
--   Deploy order: the web build that calls backup_status may go live before or after this file (it shows a neutral
--   note while the function is missing).
--   Rollback after COMMIT: DROP FUNCTION public.backup_status(), public.backup_heartbeat(bigint, text, integer);
--   DROP TABLE public.backup_runs; ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT ON TABLES,
--   SEQUENCES FROM dentos_backup; REVOKE ALL ON ALL TABLES / SEQUENCES IN SCHEMA public FROM dentos_backup;
--   DROP ROLE dentos_backup (after revoking its auth grants, if any). No clinic data is touched.

BEGIN;

-- ŞİFRE YENİLEME: dentos_backup şifresini yenilemek için yalnız bu satırda 'off' yerine 'on' yazın.
-- (Rol ilk kez oluşturulurken şifre her durumda üretilir ve bir kez gösterilir.)
SELECT set_config('dentos.backup_rotate_password', 'off', true);

-- ---------------------------------------------------------------------------
-- 1. Preflight
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_me record;
  v_missing text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION '0029 Supabase SQL editöründe postgres rolüyle çalıştırılmalı (şu anki rol: %).', current_user;
  END IF;

  SELECT r.rolsuper, r.rolcreaterole, r.rolbypassrls
    INTO v_me
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = current_user;
  IF NOT v_me.rolsuper THEN
    IF current_setting('server_version_num')::int < 160000 THEN
      RAISE EXCEPTION 'PostgreSQL % üzerinde BYPASSRLS rolünü yalnız süper kullanıcı oluşturabilir; yedek rolü kurulamaz.',
        current_setting('server_version');
    END IF;
    IF NOT v_me.rolcreaterole OR NOT v_me.rolbypassrls THEN
      RAISE EXCEPTION 'postgres rolünde CREATEROLE ve BYPASSRLS birlikte yok (CREATEROLE: %, BYPASSRLS: %); RLS''i aşan yedek rolü oluşturulamaz. Supabase desteğine danışın.',
        v_me.rolcreaterole, v_me.rolbypassrls;
    END IF;
  END IF;

  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY['public.current_app_role()', 'auth.uid()']) AS f(sig)
  WHERE to_regprocedure(f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Faz 0 eksik, önce 0019 uygulanmalı: %', v_missing;
  END IF;

  SELECT string_agg(f.sig, ', ')
    INTO v_missing
  FROM unnest(ARRAY['gen_random_bytes(integer)', 'hmac(bytea,bytea,text)']) AS f(sig)
  WHERE to_regprocedure('extensions.' || f.sig) IS NULL
    AND to_regprocedure('public.' || f.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'pgcrypto eklentisi bulunamadı (%): Supabase → Database → Extensions → pgcrypto''yu açıp yeniden çalıştırın.',
      v_missing;
  END IF;

  SELECT string_agg(r.n, ', ')
    INTO v_missing
  FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(n)
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname = r.n);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Supabase rolleri bulunamadı: %', v_missing;
  END IF;

  SELECT string_agg(e.col, ', ')
    INTO v_missing
  FROM (VALUES ('users', 'role'), ('users', 'is_active'), ('users', 'auth_user_id'), ('users', 'created_at')) AS e(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name::text = e.col
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'public.users beklenen sütunları içermiyor: %', v_missing;
  END IF;

  IF to_regclass('public.backup_runs') IS NOT NULL THEN
    SELECT string_agg(format('%s (%s beklenirken %s)', e.col, e.udt, coalesce(c.udt_name::text, 'yok')), ', ')
      INTO v_missing
    FROM (VALUES ('id', 'int8'), ('ran_at', 'timestamptz'), ('size_bytes', 'int8'), ('sha256', 'text'),
                 ('toc_entries', 'int4'), ('note', 'text')) AS e(col, udt)
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public' AND c.table_name = 'backup_runs' AND c.column_name::text = e.col
    WHERE c.udt_name::text IS DISTINCT FROM e.udt;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'public.backup_runs beklenen yapıda değil: %', v_missing;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'dentos_backup' AND r.rolsuper) THEN
    RAISE EXCEPTION 'dentos_backup süper kullanıcı olarak tanımlı; bu rol yedek için kullanılamaz. Rolü silip yeniden çalıştırın.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Session helpers (temporary; gone when the SQL editor session ends) and the one-time result table
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS pg_temp.dentos_backup_sonuc;
CREATE TEMP TABLE dentos_backup_sonuc (
  sira integer PRIMARY KEY,
  baslik text NOT NULL,
  deger text NOT NULL
);

-- plpgsql (not sql): names are resolved at call time under the function's own search_path, wherever pgcrypto lives.
CREATE OR REPLACE FUNCTION pg_temp.dentos_backup__random_bytes(p_n integer)
RETURNS bytea
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, extensions, public
AS $fn$
BEGIN
  RETURN gen_random_bytes(p_n);
END;
$fn$;

-- SCRAM-SHA-256 verifier as PostgreSQL stores it: SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey> (base64).
-- SaltedPassword = PBKDF2-HMAC-SHA-256(password, salt, iterations) with a 32-byte output, i.e. one block:
-- U1 = HMAC(password, salt || INT(1)), Ui = HMAC(password, U(i-1)), SaltedPassword = U1 xor … xor Uc.
-- ClientKey = HMAC(SaltedPassword, 'Client Key'), StoredKey = SHA-256(ClientKey), ServerKey = HMAC(SaltedPassword,
-- 'Server Key'). pgcrypto: hmac(data, key, type). The password is printable ASCII, so SASLprep leaves it unchanged.
CREATE OR REPLACE FUNCTION pg_temp.dentos_backup__scram(p_password text, p_salt bytea, p_iterations integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, extensions, public
AS $fn$
DECLARE
  v_key bytea;
  v_u bytea;
  v_t bytea;
  v_i integer;
  v_k integer;
BEGIN
  IF p_password IS NULL OR p_password !~ '^[!-~]+$' OR p_salt IS NULL OR length(p_salt) < 8
     OR p_iterations IS NULL OR p_iterations < 1 THEN
    RAISE EXCEPTION 'dentos_backup__scram: geçersiz girdi';
  END IF;
  v_key := convert_to(p_password, 'UTF8');
  v_u := hmac(p_salt || decode('00000001', 'hex'), v_key, 'sha256');
  v_t := v_u;
  FOR v_i IN 2..p_iterations LOOP
    v_u := hmac(v_u, v_key, 'sha256');
    FOR v_k IN 0..31 LOOP
      v_t := set_byte(v_t, v_k, get_byte(v_t, v_k) # get_byte(v_u, v_k));
    END LOOP;
  END LOOP;
  RETURN 'SCRAM-SHA-256$' || p_iterations::text || ':' || encode(p_salt, 'base64') || '$'
         || encode(sha256(hmac(convert_to('Client Key', 'UTF8'), v_t, 'sha256')), 'base64') || ':'
         || encode(hmac(convert_to('Server Key', 'UTF8'), v_t, 'sha256'), 'base64');
END;
$fn$;

-- The verifier code must reproduce RFC 7677's example (user 'user', password 'pencil'); otherwise a role with an
-- unusable password would be created. StoredKey / ServerKey below were derived from that example and checked against
-- its ClientProof and ServerSignature.
DO $$
BEGIN
  IF pg_temp.dentos_backup__scram('pencil', decode('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'), 4096)
     IS DISTINCT FROM 'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU='
  THEN
    RAISE EXCEPTION 'Öz denetim: SCRAM-SHA-256 hesabı RFC 7677 örneğini vermiyor; rol oluşturulmadı.';
  END IF;
  IF length(pg_temp.dentos_backup__random_bytes(32)) <> 32 THEN
    RAISE EXCEPTION 'Öz denetim: gen_random_bytes 32 bayt döndürmedi.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Role dentos_backup
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rotate boolean := lower(coalesce(nullif(current_setting('dentos.backup_rotate_password', true), ''), 'off'))
                      IN ('on', 'true', 'evet', '1');
  v_exists boolean := EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'dentos_backup');
  v_password text;
  v_verifier text;
  v_err text;
BEGIN
  IF NOT v_exists OR v_rotate THEN
    v_password := encode(pg_temp.dentos_backup__random_bytes(32), 'hex');
    v_verifier := pg_temp.dentos_backup__scram(v_password, pg_temp.dentos_backup__random_bytes(16), 4096);
  END IF;

  BEGIN
    IF NOT v_exists THEN
      EXECUTE format('CREATE ROLE dentos_backup WITH LOGIN NOINHERIT BYPASSRLS CONNECTION LIMIT 2 PASSWORD %L',
                     v_verifier);
    ELSE
      EXECUTE 'ALTER ROLE dentos_backup WITH LOGIN NOINHERIT BYPASSRLS CONNECTION LIMIT 2 VALID UNTIL ''infinity''';
      IF v_rotate THEN
        EXECUTE format('ALTER ROLE dentos_backup WITH PASSWORD %L', v_verifier);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION USING
      MESSAGE = format('dentos_backup rolü %s (%s: %s). postgres rolünün CREATEROLE ve BYPASSRLS yetkisi (ve var olan rolde ADMIN yetkisi) gerekir.',
                       CASE WHEN v_exists THEN 'güncellenemedi' ELSE 'oluşturulamadı' END, SQLSTATE, v_err),
      ERRCODE = '42501',
      HINT = 'BACKUP_ROLE';
  END;

  -- Attributes an older hand-made role might carry (only touched when set, because changing them needs the same
  -- attribute on postgres).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'dentos_backup' AND r.rolcreatedb) THEN
    EXECUTE 'ALTER ROLE dentos_backup NOCREATEDB';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'dentos_backup' AND r.rolcreaterole) THEN
    EXECUTE 'ALTER ROLE dentos_backup NOCREATEROLE';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'dentos_backup' AND r.rolreplication) THEN
    EXECUTE 'ALTER ROLE dentos_backup NOREPLICATION';
  END IF;

  INSERT INTO pg_temp.dentos_backup_sonuc (sira, baslik, deger) VALUES
    (1, 'Yedek rolü',
     CASE WHEN v_exists THEN 'dentos_backup zaten vardı; ayarları ve yetkileri yeniden uygulandı.'
          ELSE 'dentos_backup oluşturuldu.' END),
    (2, 'Şifre (DENTOS_BACKUP_DB_PASSWORD)',
     coalesce(v_password,
              'Değişmedi (eski şifre geçerli, gösterilemez). Yeni şifre gerekiyorsa dosyanın başındaki dentos.backup_rotate_password satırında off yerine on yazıp yeniden çalıştırın.'));
END $$;

ALTER ROLE dentos_backup SET default_transaction_read_only = on;
ALTER ROLE dentos_backup SET statement_timeout = '10min';
ALTER ROLE dentos_backup SET idle_in_transaction_session_timeout = '10min';

-- ---------------------------------------------------------------------------
-- 4. Backup run log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  toc_entries integer NOT NULL,
  note text,
  CONSTRAINT backup_runs_size_positive CHECK (size_bytes > 0),
  CONSTRAINT backup_runs_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT backup_runs_toc_positive CHECK (toc_entries > 0),
  CONSTRAINT backup_runs_note_length CHECK (note IS NULL OR char_length(note) <= 200)
);

COMMENT ON TABLE public.backup_runs IS
  'Nightly backup runs (GitHub Actions, private repo dentos-yedek). Written only by backup_heartbeat; read by backup_status.';

CREATE INDEX IF NOT EXISTS idx_backup_runs_ran_at ON public.backup_runs (ran_at DESC, id DESC);

ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.backup_runs FROM PUBLIC, anon, authenticated, service_role;
DO $$
DECLARE
  v_seq text := pg_get_serial_sequence('public.backup_runs', 'id');
BEGIN
  IF v_seq IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role', v_seq);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_heartbeat(p_size bigint, p_sha256 text, p_toc integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_row public.backup_runs;
BEGIN
  IF p_size IS NULL OR p_size <= 0 OR p_size > 1099511627776 THEN
    RAISE EXCEPTION USING MESSAGE = 'Yedek boyutu geçersiz (1 bayt ile 1 TiB arasında olmalı).',
                          ERRCODE = '22023', HINT = 'BACKUP_SIZE';
  END IF;
  IF v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING MESSAGE = 'SHA-256 özeti 64 onaltılık karakter olmalı.',
                          ERRCODE = '22023', HINT = 'BACKUP_SHA256';
  END IF;
  IF p_toc IS NULL OR p_toc <= 0 OR p_toc > 10000000 THEN
    RAISE EXCEPTION USING MESSAGE = 'Yedek içindekiler (TOC) sayısı geçersiz.',
                          ERRCODE = '22023', HINT = 'BACKUP_TOC';
  END IF;

  INSERT INTO public.backup_runs (size_bytes, sha256, toc_entries, note)
  VALUES (p_size, v_sha, p_toc, left(nullif(btrim(coalesce(current_setting('application_name', true), '')), ''), 200))
  RETURNING * INTO v_row;

  -- Keep the newest 400 runs.
  DELETE FROM public.backup_runs r
  WHERE r.id < (SELECT min(k.id) FROM (SELECT b.id FROM public.backup_runs b ORDER BY b.id DESC LIMIT 400) k);

  RETURN jsonb_build_object('ok', true, 'id', v_row.id, 'ran_at', v_row.ran_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.backup_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last jsonb;
BEGIN
  IF public.current_app_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION USING MESSAGE = 'Otomatik yedek durumunu yalnızca klinik sahibi görebilir.',
                          ERRCODE = '42501', HINT = 'BACKUP_FORBIDDEN';
  END IF;

  SELECT jsonb_build_object('ran_at', r.ran_at, 'size_bytes', r.size_bytes, 'toc_entries', r.toc_entries)
    INTO v_last
  FROM public.backup_runs r
  ORDER BY r.ran_at DESC, r.id DESC
  LIMIT 1;

  RETURN jsonb_build_object('ok', true, 'last', v_last, 'now', now());
END;
$$;

REVOKE ALL ON FUNCTION public.backup_heartbeat(bigint, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_heartbeat(bigint, text, integer) TO dentos_backup;

REVOKE ALL ON FUNCTION public.backup_status() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_status() TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Read-only privileges of dentos_backup (after backup_runs exists, so it is included)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO dentos_backup;
REVOKE CREATE ON SCHEMA public FROM dentos_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dentos_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM dentos_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM dentos_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dentos_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO dentos_backup;
GRANT EXECUTE ON FUNCTION public.backup_heartbeat(bigint, text, integer) TO dentos_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO dentos_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON SEQUENCES TO dentos_backup;

-- Login accounts (auth.users / auth.identities): data only, so a restore keeps everyone's password. Supabase owns the
-- auth schema; whether postgres may pass SELECT on to another role differs between projects, so try and read back.
DO $$
DECLARE
  v_err text;
  v_ok boolean := false;
BEGIN
  IF to_regclass('auth.users') IS NULL OR to_regclass('auth.identities') IS NULL THEN
    v_err := 'auth.users / auth.identities bulunamadı';
  ELSE
    BEGIN
      GRANT USAGE ON SCHEMA auth TO dentos_backup;
      GRANT SELECT ON TABLE auth.users, auth.identities TO dentos_backup;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    -- A GRANT without grant option only warns, so read the result back.
    IF has_schema_privilege('dentos_backup', 'auth', 'USAGE') THEN
      v_ok := has_table_privilege('dentos_backup', 'auth.users', 'SELECT')
              AND has_table_privilege('dentos_backup', 'auth.identities', 'SELECT');
    END IF;
  END IF;

  INSERT INTO pg_temp.dentos_backup_sonuc (sira, baslik, deger) VALUES
    (3, 'Giriş hesapları (auth.users / auth.identities)',
     CASE WHEN v_ok
       THEN 'Yedeğe dahil: geri yüklemede personel aynı e-posta ve şifreyle girebilir.'
       ELSE 'Yedeğe dahil değil (' || coalesce(v_err, 'Supabase postgres rolüne bu izni verdirmiyor')
            || '). Yedek yine çalışır; geri yüklemede personel yeniden davet edilir (dentos-yedek/GERI-YUKLEME.md).'
     END);
  IF NOT v_ok THEN
    RAISE NOTICE 'auth.users / auth.identities yedek rolüne açılamadı: %', coalesce(v_err, 'izin verilmedi');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Self-checks
-- ---------------------------------------------------------------------------

-- 7.1 Role attributes, settings, memberships.
DO $$
DECLARE
  v_r record;
  v_bad text[] := '{}'::text[];
BEGIN
  SELECT * INTO v_r FROM pg_catalog.pg_roles r WHERE r.rolname = 'dentos_backup';
  IF v_r.rolname IS NULL THEN
    RAISE EXCEPTION 'Öz denetim: dentos_backup rolü yok.';
  END IF;
  IF NOT v_r.rolcanlogin THEN v_bad := array_append(v_bad, 'LOGIN yok'); END IF;
  IF v_r.rolinherit THEN v_bad := array_append(v_bad, 'INHERIT açık'); END IF;
  IF NOT v_r.rolbypassrls THEN v_bad := array_append(v_bad, 'BYPASSRLS yok'); END IF;
  IF v_r.rolsuper OR v_r.rolcreaterole OR v_r.rolcreatedb OR v_r.rolreplication THEN
    v_bad := array_append(v_bad, 'fazladan yetki (SUPERUSER / CREATEROLE / CREATEDB / REPLICATION)');
  END IF;
  IF v_r.rolconnlimit <> 2 THEN v_bad := array_append(v_bad, 'CONNECTION LIMIT ' || v_r.rolconnlimit); END IF;
  IF v_r.rolvaliduntil IS NOT NULL AND v_r.rolvaliduntil <> 'infinity'::timestamptz THEN
    v_bad := array_append(v_bad, 'VALID UNTIL ' || v_r.rolvaliduntil);
  END IF;
  IF v_r.rolconfig IS NULL
     OR NOT ('default_transaction_read_only=on' = ANY (v_r.rolconfig))
     OR NOT ('statement_timeout=10min' = ANY (v_r.rolconfig))
     OR NOT ('idle_in_transaction_session_timeout=10min' = ANY (v_r.rolconfig)) THEN
    v_bad := array_append(v_bad, 'rol ayarları: ' || coalesce(array_to_string(v_r.rolconfig, ', '), '(yok)'));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = v_r.oid) THEN
    v_bad := array_append(v_bad, 'başka rollerin üyesi: ' || (
      SELECT string_agg(g.rolname, ', ') FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles g ON g.oid = m.roleid WHERE m.member = v_r.oid));
  END IF;
  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'Öz denetim (dentos_backup rolü): %', array_to_string(v_bad, '; ');
  END IF;
END $$;

-- 7.2 Read-only privilege matrix over every relation in public (extension members excluded: pg_dump skips them).
DO $$
DECLARE
  v_write text := 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
                  || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ', MAINTAIN' ELSE '' END;
  v_bad text;
  v_n bigint;
BEGIN
  SELECT string_agg(c.relname::text, ', ' ORDER BY c.relname)
    INTO v_bad
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    AND NOT CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('dentos_backup', c.oid, 'SELECT')
                 ELSE has_table_privilege('dentos_backup', c.oid, 'SELECT') END;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: dentos_backup şunları okuyamıyor (sahibi postgres olmayan nesneler olabilir): %', v_bad;
  END IF;

  SELECT string_agg(c.relname::text, ', ' ORDER BY c.relname)
    INTO v_bad
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('dentos_backup', c.oid, 'USAGE, UPDATE')
             ELSE has_table_privilege('dentos_backup', c.oid, v_write) END;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Öz denetim: dentos_backup şunlara yazabiliyor: %', v_bad;
  END IF;

  IF has_schema_privilege('dentos_backup', 'public', 'CREATE') THEN
    RAISE NOTICE 'public şemasında CREATE yetkisi PUBLIC''e açık; dentos_backup de nesne oluşturabilir (oturumu salt okunur).';
  END IF;
  IF has_database_privilege('dentos_backup', current_database(), 'CREATE') THEN
    RAISE NOTICE 'Veritabanında CREATE yetkisi PUBLIC''e açık; dentos_backup de şema oluşturabilir (oturumu salt okunur).';
  END IF;

  SELECT count(*)
    INTO v_n
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
    AND p.proname <> 'backup_heartbeat'
    AND has_function_privilege('dentos_backup', p.oid, 'EXECUTE');
  IF v_n > 0 THEN
    RAISE NOTICE 'dentos_backup, PUBLIC''e açık % SECURITY DEFINER fonksiyonu çalıştırabilir (eski migration''lar); oturumu salt okunur olduğu için bu fonksiyonlar veri yazamaz.', v_n;
  END IF;
END $$;

-- 7.3 Function ACLs and shape; backup_runs RLS without policies, no client privileges.
DO $$
DECLARE
  v_hb regprocedure := to_regprocedure('public.backup_heartbeat(bigint,text,integer)');
  v_st regprocedure := to_regprocedure('public.backup_status()');
  v_bad text[] := '{}'::text[];
BEGIN
  IF v_hb IS NULL OR v_st IS NULL THEN
    RAISE EXCEPTION 'Öz denetim: backup_heartbeat / backup_status oluşturulamadı.';
  END IF;
  IF NOT has_function_privilege('dentos_backup', v_hb, 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'dentos_backup backup_heartbeat çalıştıramıyor');
  END IF;
  IF has_function_privilege('anon', v_hb, 'EXECUTE') OR has_function_privilege('authenticated', v_hb, 'EXECUTE')
     OR has_function_privilege('service_role', v_hb, 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'backup_heartbeat istemcilere açık');
  END IF;
  IF NOT has_function_privilege('authenticated', v_st, 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'authenticated backup_status çalıştıramıyor');
  END IF;
  IF has_function_privilege('anon', v_st, 'EXECUTE') OR has_function_privilege('service_role', v_st, 'EXECUTE')
     OR has_function_privilege('dentos_backup', v_st, 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'backup_status anon / service_role / dentos_backup için açık');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN (v_hb, v_st)
             AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT ('search_path=public' = ANY (p.proconfig)))) THEN
    v_bad := array_append(v_bad, 'SECURITY DEFINER / search_path = public eksik');
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = 'public.backup_runs'::regclass) THEN
    v_bad := array_append(v_bad, 'backup_runs RLS kapalı');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'backup_runs') THEN
    v_bad := array_append(v_bad, 'backup_runs üzerinde politika var (olmamalı)');
  END IF;
  IF has_table_privilege('anon', 'public.backup_runs', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.backup_runs', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('service_role', 'public.backup_runs', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    v_bad := array_append(v_bad, 'backup_runs istemcilere açık');
  END IF;
  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'Öz denetim (yedek fonksiyonları): %', array_to_string(v_bad, '; ');
  END IF;
END $$;

-- 7.4 Replay inside a block that is always rolled back: heartbeat validation and retention, status for the editor (no
--     session), an active owner and an active non-owner (when such logins exist). auth.uid() is simulated through
--     request.jwt.claims and request.jwt.claim.sub / role, as in 0027. Nothing survives the block.
DO $$
DECLARE
  v_before bigint;
  v_after bigint;
  v_j jsonb;
  v_id bigint;
  v_hint text;
  v_auth uuid;
  v_case record;
  v_claims_before text := current_setting('request.jwt.claims', true);
  v_sub_before text := current_setting('request.jwt.claim.sub', true);
  v_role_before text := current_setting('request.jwt.claim.role', true);
  v_fail text[] := '{}'::text[];
BEGIN
  SELECT count(*) INTO v_before FROM public.backup_runs;
  BEGIN
    -- Valid call; the hash is normalised to lower case.
    v_j := public.backup_heartbeat(123456, upper(repeat('ab', 32)), 42);
    v_id := (v_j ->> 'id')::bigint;
    IF NOT coalesce((v_j ->> 'ok')::boolean, false) OR NOT EXISTS (
      SELECT 1 FROM public.backup_runs r
      WHERE r.id = v_id AND r.size_bytes = 123456 AND r.sha256 = repeat('ab', 32) AND r.toc_entries = 42
    ) THEN
      v_fail := array_append(v_fail, 'geçerli çağrı: ' || coalesce(v_j::text, '-'));
    END IF;

    -- Invalid inputs.
    FOR v_case IN
      SELECT * FROM (VALUES
        (0::bigint, repeat('ab', 32), 1, 'BACKUP_SIZE'),
        (NULL::bigint, repeat('ab', 32), 1, 'BACKUP_SIZE'),
        (1099511627777::bigint, repeat('ab', 32), 1, 'BACKUP_SIZE'),
        (1::bigint, 'xyz', 1, 'BACKUP_SHA256'),
        (1::bigint, repeat('ab', 31), 1, 'BACKUP_SHA256'),
        (1::bigint, NULL, 1, 'BACKUP_SHA256'),
        (1::bigint, repeat('ab', 32), 0, 'BACKUP_TOC'),
        (1::bigint, repeat('ab', 32), NULL, 'BACKUP_TOC')
      ) AS t(size, sha, toc, want)
    LOOP
      v_hint := NULL;
      BEGIN
        PERFORM public.backup_heartbeat(v_case.size, v_case.sha, v_case.toc);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      END;
      IF v_hint IS DISTINCT FROM v_case.want THEN
        v_fail := array_append(v_fail, format('geçersiz girdi (%s, %s, %s): %s', v_case.size, v_case.sha, v_case.toc,
                                              coalesce(v_hint, 'hata yok')));
      END IF;
    END LOOP;

    -- Retention: only the newest 400 runs remain, the newest included.
    INSERT INTO public.backup_runs (size_bytes, sha256, toc_entries, note)
    SELECT 1, repeat('cd', 32), 1, 'oz-denetim' FROM generate_series(1, 410);
    v_j := public.backup_heartbeat(2, repeat('ef', 32), 3);
    SELECT count(*) INTO v_after FROM public.backup_runs;
    IF v_after <> 400 OR NOT EXISTS (SELECT 1 FROM public.backup_runs r WHERE r.id = (v_j ->> 'id')::bigint) THEN
      v_fail := array_append(v_fail, 'saklama: ' || v_after || ' satır');
    END IF;

    -- Status: the SQL editor (no session) is refused.
    v_hint := NULL;
    BEGIN
      PERFORM public.backup_status();
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'BACKUP_FORBIDDEN' THEN
      v_fail := array_append(v_fail, 'oturumsuz durum sorgusu: ' || coalesce(v_hint, 'reddedilmedi'));
    END IF;

    -- Status as an active owner: the newest run, without the hash.
    SELECT u.auth_user_id INTO v_auth
    FROM public.users u
    WHERE u.role = 'owner' AND u.is_active = true AND u.auth_user_id IS NOT NULL
    ORDER BY u.created_at, u.id
    LIMIT 1;
    IF v_auth IS NOT NULL THEN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', v_auth::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      IF public.current_app_role() IS DISTINCT FROM 'owner' THEN
        v_fail := array_append(v_fail, 'auth.uid() oturum taklidini okumuyor');
      ELSE
        v_j := public.backup_status();
        IF NOT coalesce((v_j ->> 'ok')::boolean, false)
           OR (v_j #>> '{last,size_bytes}')::bigint IS DISTINCT FROM 2
           OR (v_j #>> '{last,toc_entries}')::integer IS DISTINCT FROM 3
           OR v_j #> '{last,ran_at}' IS NULL
           OR v_j -> 'now' IS NULL
           OR v_j::text LIKE '%sha256%' THEN
          v_fail := array_append(v_fail, 'sahip durum sorgusu: ' || left(v_j::text, 200));
        END IF;
      END IF;
    ELSE
      RAISE NOTICE 'Öz denetim: girişi olan aktif klinik sahibi yok; sahip durum sorgusu atlandı.';
    END IF;

    -- Status as an active non-owner is refused.
    v_auth := NULL;
    SELECT u.auth_user_id INTO v_auth
    FROM public.users u
    WHERE u.role <> 'owner' AND u.is_active = true AND u.auth_user_id IS NOT NULL
    ORDER BY u.created_at, u.id
    LIMIT 1;
    IF v_auth IS NOT NULL THEN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_auth, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', v_auth::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      v_hint := NULL;
      BEGIN
        PERFORM public.backup_status();
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      END;
      IF v_hint IS DISTINCT FROM 'BACKUP_FORBIDDEN' THEN
        v_fail := array_append(v_fail, 'sahip olmayan durum sorgusu: ' || coalesce(v_hint, 'reddedilmedi'));
      END IF;
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF cardinality(v_fail) > 0 THEN
      RAISE EXCEPTION 'Öz denetim (yedek kalp atışı / durum): %', array_to_string(v_fail, ' | ');
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'backup_selfcheck_rollback';
  EXCEPTION WHEN SQLSTATE 'PT999' THEN
    NULL;   -- everything above is rolled back
  END;

  SELECT count(*) INTO v_after FROM public.backup_runs;
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'Öz denetim kayıtları geri alınmadı (% / %).', v_before, v_after;
  END IF;
  IF nullif(current_setting('request.jwt.claims', true), '') IS DISTINCT FROM nullif(v_claims_before, '')
     OR nullif(current_setting('request.jwt.claim.sub', true), '') IS DISTINCT FROM nullif(v_sub_before, '')
     OR nullif(current_setting('request.jwt.claim.role', true), '') IS DISTINCT FROM nullif(v_role_before, '') THEN
    RAISE EXCEPTION 'request.jwt.claims / request.jwt.claim.* öz denetimden sonra eski değerine dönmedi.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Result rows and commit
-- ---------------------------------------------------------------------------
INSERT INTO pg_temp.dentos_backup_sonuc (sira, baslik, deger)
SELECT 4, 'Sonraki adım',
       CASE WHEN s.deger LIKE 'Değişmedi%'
         THEN 'Bir şey yapmanız gerekmiyor. Gece yedeği aynı şifreyle çalışmaya devam eder.'
         ELSE 'Şifreyi ŞİMDİ kopyalayın: GitHub → dentos-yedek → Settings → Secrets and variables → Actions → New repository secret, ad: DENTOS_BACKUP_DB_PASSWORD. Bu şifre başka hiçbir yerde saklanmaz ve bir daha gösterilmez.'
       END
FROM pg_temp.dentos_backup_sonuc s
WHERE s.sira = 2;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_temp.dentos_backup_sonuc) <> 4 THEN
    RAISE EXCEPTION 'Öz denetim: sonuç satırları eksik.';
  END IF;
END $$;

-- Make the API see backup_status now. Delivered at COMMIT, so nothing is reloaded on rollback.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- Shown once: the result grid of the SQL editor displays this last statement. It also empties the session's temp table,
-- so the password is no longer held anywhere in the database.
WITH sonuc AS (
  DELETE FROM pg_temp.dentos_backup_sonuc RETURNING sira, baslik, deger
)
SELECT baslik AS "Başlık", deger AS "Değer"
FROM sonuc
ORDER BY sira;
