-- Supabase projects expose public through PostgREST. OpenRift uses its own
-- authenticated API, so the native application tables/functions must not be
-- callable by Supabase's public, anon, or authenticated roles.
-- Run before migrations to set defaults, and after migrations to harden the
-- objects already created by the migration role. This does not enable RLS.
DO $hosted_access$
DECLARE
  migration_role oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
  grantee record;
  object record;
BEGIN
  -- Ensure objects created by this migration role in public do not receive
  -- default access for PUBLIC or Supabase's API roles.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC',
    current_user
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC',
    current_user
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );

  FOR grantee IN
    SELECT rolname
    FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
      current_user,
      grantee.rolname
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
      current_user,
      grantee.rolname
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I',
      current_user,
      grantee.rolname
    );
  END LOOP;

  -- Remove access only from objects owned by the current migration role.
  -- Objects belonging to installed extensions and provider-owned objects are
  -- deliberately left alone.
  FOR object IN
    SELECT c.oid, n.nspname, c.relname, c.relkind
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relowner = migration_role
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
  LOOP
    IF object.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC', object.nspname, object.relname);
    ELSE
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC', object.nspname, object.relname);
    END IF;

    FOR grantee IN
      SELECT rolname
      FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated')
    LOOP
      IF object.relkind = 'S' THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I', object.nspname, object.relname, grantee.rolname);
      ELSE
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I', object.nspname, object.relname, grantee.rolname);
      END IF;
    END LOOP;
  END LOOP;

  FOR object IN
    SELECT p.oid, n.nspname, p.proname, p.prokind,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proowner = migration_role
      AND p.prokind IN ('f', 'p', 'w')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS d
        WHERE d.classid = 'pg_proc'::regclass
          AND d.objid = p.oid
          AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ROUTINE %I.%I(%s) FROM PUBLIC',
      object.nspname,
      object.proname,
      object.identity_arguments
    );

    FOR grantee IN
      SELECT rolname
      FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated')
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ROUTINE %I.%I(%s) FROM %I',
        object.nspname,
        object.proname,
        object.identity_arguments,
        grantee.rolname
      );
    END LOOP;
  END LOOP;
END;
$hosted_access$;
