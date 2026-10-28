-- Hosted PostgreSQL compatibility for OpenRift's native API schema.
-- This file is intentionally safe to run before migrations and on every boot.
DO $hosted_compat$
DECLARE
  version_num integer := current_setting('server_version_num')::integer;
BEGIN
  IF version_num < 150000 THEN
    RAISE EXCEPTION 'OpenRift hosted deployment requires PostgreSQL 15 or newer (server_version_num=%)', version_num;
  END IF;

  -- PostgreSQL 18 provides uuidv7() in pg_catalog. Keep any existing
  -- implementation untouched; provide a standards-compliant fallback on
  -- earlier versions where the function is not visible or in public.
  IF to_regprocedure('uuidv7()') IS NULL
     AND to_regprocedure('pg_catalog.uuidv7(interval)') IS NULL
     AND to_regprocedure('public.uuidv7()') IS NULL THEN
    EXECUTE $create_uuidv7$
      CREATE FUNCTION public.uuidv7()
      RETURNS uuid
      LANGUAGE plpgsql
      VOLATILE
      PARALLEL SAFE
      AS $function$
        DECLARE
          bytes bytea := uuid_send(gen_random_uuid());
          milliseconds bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
          i integer;
        BEGIN
          FOR i IN 0..5 LOOP
            bytes := set_byte(bytes, i, ((milliseconds >> ((5-i)*8)) & 255)::integer);
          END LOOP;
          bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
          bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
          RETURN encode(bytes, 'hex')::uuid;
        END;
      $function$
    $create_uuidv7$;
  END IF;
END;
$hosted_compat$;
