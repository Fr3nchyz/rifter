-- Rifter's additive schema. Run after OpenRift migrations. Safe to rerun.
BEGIN;
SELECT pg_advisory_xact_lock(782438221);
CREATE TABLE IF NOT EXISTS rifter_imports (
 id uuid PRIMARY KEY DEFAULT uuidv7(), user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 raw_input text NOT NULL, source text NOT NULL, fingerprint text NOT NULL,
 format text NOT NULL, destination jsonb NOT NULL CHECK (jsonb_typeof(destination)='object'),
 rows jsonb NOT NULL CHECK (jsonb_typeof(rows)='array'),
 warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings)='array'),
 status text NOT NULL DEFAULT 'pending',
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz
);
ALTER TABLE rifter_imports DROP CONSTRAINT IF EXISTS rifter_imports_status_check;
ALTER TABLE rifter_imports ADD CONSTRAINT rifter_imports_status_check CHECK(status IN ('pending','applied','undone'));
CREATE INDEX IF NOT EXISTS rifter_imports_owner ON rifter_imports(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS rifter_imports_fingerprint ON rifter_imports(user_id,fingerprint);
CREATE TABLE IF NOT EXISTS rifter_deck_state (
 id uuid PRIMARY KEY REFERENCES decks(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'aspiring' CHECK(status IN ('active','aspiring')),
 source text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS rifter_actions (
 id uuid PRIMARY KEY DEFAULT uuidv7(), user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(), label text NOT NULL,
 reverses uuid REFERENCES rifter_actions(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,transaction_id), UNIQUE(reverses)
);
ALTER TABLE rifter_imports ADD COLUMN IF NOT EXISTS applied_action_id uuid REFERENCES rifter_actions(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS rifter_changes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 action_id uuid NOT NULL REFERENCES rifter_actions(id) ON DELETE CASCADE,
 entity text NOT NULL, row_id uuid NOT NULL,
 before_row jsonb CHECK(before_row IS NULL OR jsonb_typeof(before_row)='object'),
 after_row jsonb CHECK(after_row IS NULL OR jsonb_typeof(after_row)='object')
);
CREATE INDEX IF NOT EXISTS rifter_changes_action ON rifter_changes(action_id,id);
CREATE TABLE IF NOT EXISTS rifter_stock_snapshots (
 id uuid PRIMARY KEY DEFAULT uuidv7(),user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 store text NOT NULL CHECK(store='gamekeeper-verdun'),raw_csv text NOT NULL,
 records integer NOT NULL CHECK(records>0),coverage text NOT NULL CHECK(coverage IN ('complete-pagination','uploaded-unverified-coverage')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rifter_stock_refreshes (
 id uuid PRIMARY KEY DEFAULT uuidv7(),user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('running','complete','failed','cancelled')),error text,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS rifter_refresh_running ON rifter_stock_refreshes(user_id) WHERE status='running';

CREATE OR REPLACE FUNCTION rifter_owner(entity text, r jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE owner_id text;
BEGIN
 IF r IS NULL THEN RETURN NULL; END IF;
 IF entity='collections' THEN RETURN CASE WHEN r->>'group_id' IS NULL THEN r->>'user_id' ELSE '__shared__' END;
 ELSIF entity='decks' THEN RETURN r->>'user_id';
 ELSIF entity='copies' THEN
   SELECT CASE WHEN group_id IS NULL THEN user_id ELSE '__shared__' END INTO owner_id FROM collections WHERE id=(r->>'collection_id')::uuid;
 ELSIF entity IN ('deck_cards','deck_plans','deck_matchup_plans') THEN
   SELECT user_id INTO owner_id FROM decks WHERE id=(r->>'deck_id')::uuid;
 ELSIF entity='deck_matchup_swaps' THEN
   SELECT d.user_id INTO owner_id FROM decks d JOIN deck_matchup_plans p ON p.deck_id=d.id WHERE p.id=(r->>'plan_id')::uuid;
 ELSIF entity='rifter_deck_state' THEN
   SELECT user_id INTO owner_id FROM decks WHERE id=(r->>'id')::uuid;
 END IF;
 RETURN owner_id;
END $$;

-- Record native OpenRift mutations as well as Rifter mutations, in their original
-- transaction. No parallel collection database and no best-effort audit writes.
CREATE OR REPLACE FUNCTION rifter_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b jsonb; a jsonb; r jsonb; owner_id text; aid uuid;
BEGIN
 b := CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 a := CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF b IS NOT DISTINCT FROM a THEN RETURN coalesce(NEW,OLD); END IF;
 r := coalesce(a,b);
 -- Cross-owner/shared transfers are intentionally outside personal undo. Do
 -- not put another owner's before-image into a recipient-controlled journal.
 IF TG_OP='UPDATE' AND rifter_owner(TG_TABLE_NAME,b) IS DISTINCT FROM rifter_owner(TG_TABLE_NAME,a) THEN
   RETURN NEW;
 END IF;
 IF TG_TABLE_NAME IN ('collections','decks') THEN owner_id := r->>'user_id';
 ELSIF TG_TABLE_NAME='copies' THEN
   SELECT user_id INTO owner_id FROM collections WHERE id=(r->>'collection_id')::uuid AND group_id IS NULL;
 ELSIF TG_TABLE_NAME IN ('deck_cards','deck_plans','deck_matchup_plans') THEN
   SELECT user_id INTO owner_id FROM decks WHERE id=(r->>'deck_id')::uuid;
 ELSIF TG_TABLE_NAME='deck_matchup_swaps' THEN
   SELECT d.user_id INTO owner_id FROM decks d JOIN deck_matchup_plans p ON p.deck_id=d.id WHERE p.id=(r->>'plan_id')::uuid;
 ELSIF TG_TABLE_NAME='rifter_deck_state' THEN
   SELECT user_id INTO owner_id FROM decks WHERE id=(r->>'id')::uuid;
 END IF;
 -- During cascade deletes the parent may already be gone. Recover only from a
 -- parent change in this same transaction, never from another user's history.
 IF owner_id IS NULL AND TG_TABLE_NAME='deck_matchup_swaps' THEN
   SELECT act.user_id INTO owner_id FROM rifter_changes ch JOIN rifter_actions act ON act.id=ch.action_id
   WHERE act.transaction_id=pg_current_xact_id() AND ch.entity='deck_matchup_plans' AND ch.row_id=(r->>'plan_id')::uuid LIMIT 1;
 END IF;
 IF owner_id IS NULL AND TG_TABLE_NAME IN ('copies','deck_cards','deck_plans','deck_matchup_plans','rifter_deck_state') THEN
   SELECT act.user_id INTO owner_id FROM rifter_changes ch JOIN rifter_actions act ON act.id=ch.action_id
   WHERE act.transaction_id=pg_current_xact_id()
     AND ch.entity=CASE WHEN TG_TABLE_NAME='copies' THEN 'collections' ELSE 'decks' END
     AND ch.row_id=(CASE WHEN TG_TABLE_NAME='copies' THEN r->>'collection_id'
       WHEN TG_TABLE_NAME='rifter_deck_state' THEN r->>'id' ELSE r->>'deck_id' END)::uuid
   ORDER BY ch.id DESC LIMIT 1;
 END IF;
 IF owner_id IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id=owner_id) THEN RETURN coalesce(NEW,OLD); END IF;
 INSERT INTO rifter_actions(user_id,label)
 VALUES(owner_id,coalesce(nullif(current_setting('rifter.label',true),''),'Edit '||TG_TABLE_NAME))
 ON CONFLICT(user_id,transaction_id) DO UPDATE SET label=rifter_actions.label RETURNING id INTO aid;
 INSERT INTO rifter_changes(action_id,entity,row_id,before_row,after_row)
 VALUES(aid,TG_TABLE_NAME,(r->>'id')::uuid,b,a);
 RETURN coalesce(NEW,OLD);
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['collections','copies','decks','deck_cards','deck_plans','deck_matchup_plans','deck_matchup_swaps','rifter_deck_state'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS zz_rifter_history ON %I',t);
   EXECUTE format('DROP TRIGGER IF EXISTS aa_rifter_history_delete ON %I',t);
   EXECUTE format('CREATE TRIGGER zz_rifter_history AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION rifter_record_change()',t);
   EXECUTE format('CREATE TRIGGER aa_rifter_history_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION rifter_record_change()',t);
 END LOOP;
END $$;

-- Strict reverse-chronological reversal is deliberate: it prevents losing edits
-- and handles native cascade triggers whose execution order differs from SQL order.
CREATE OR REPLACE FUNCTION rifter_undo(target uuid, actor text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE ch record; current_row jsonb; columns_sql text; values_sql text; assignments text;
 new_action uuid; latest uuid; scope_row jsonb; scope_owner text; parent_id uuid; parent_entity text; boundary bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rifter:'||actor,0));
 PERFORM 1 FROM rifter_actions WHERE id=target AND user_id=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Action not found' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM rifter_actions WHERE reverses=target) THEN
   RAISE EXCEPTION 'Action already reversed' USING ERRCODE='40001'; END IF;
 -- Lock every audited table against concurrent native writes for the short
 -- compare-and-restore transaction, including writers outside the Rifter UI.
 LOCK TABLE collections,copies,decks,deck_cards,deck_plans,deck_matchup_plans,deck_matchup_swaps,rifter_deck_state IN SHARE ROW EXCLUSIVE MODE;
 PERFORM set_config('rifter.label','Undo action',true);
 INSERT INTO rifter_actions(user_id,label,reverses) VALUES(actor,'Undo action',target) RETURNING id INTO new_action;
 -- A row may change repeatedly in one transaction. Collapse to its first before
 -- and final after, then remove children before parents / restore parents first.
 CREATE TEMP TABLE IF NOT EXISTS rifter_restore(entity text,row_id uuid,b jsonb,a jsonb) ON COMMIT DROP;
 TRUNCATE rifter_restore;
 INSERT INTO rifter_restore
 SELECT entity,row_id,(array_agg(before_row ORDER BY id))[1],(array_agg(after_row ORDER BY id DESC))[1]
 FROM rifter_changes WHERE action_id=target GROUP BY entity,row_id;
 SELECT max(id) INTO boundary FROM rifter_changes WHERE action_id=target;
 -- State equality alone misses an A→B→A edit sequence. A later still-effective
 -- action blocks reversal even when its values match again. Explicit undo /
 -- redo chains cancel in pairs; a redone action is effective again.
 IF EXISTS (
   WITH RECURSIVE chain(root,id,depth) AS (
     SELECT id,id,0 FROM rifter_actions WHERE user_id=actor AND reverses IS NULL
     UNION ALL SELECT chain.root,a.id,chain.depth+1 FROM chain JOIN rifter_actions a ON a.reverses=chain.id WHERE a.user_id=actor
   )
   SELECT 1 FROM chain leaf
   JOIN rifter_changes touched ON touched.action_id=leaf.root
   JOIN rifter_restore r ON r.entity=touched.entity AND r.row_id=touched.row_id
   WHERE leaf.depth%2=0 AND leaf.id<>target
     AND NOT EXISTS(SELECT 1 FROM rifter_actions child WHERE child.reverses=leaf.id)
     AND EXISTS(SELECT 1 FROM rifter_changes newer WHERE newer.action_id=leaf.id AND newer.id>boundary)
 ) THEN RAISE EXCEPTION 'Later edits conflict with this action; undo newer dependent edits first' USING ERRCODE='40001'; END IF;
 FOR ch IN SELECT * FROM rifter_restore LOOP
   IF ch.entity NOT IN ('collections','copies','decks','deck_cards','deck_plans','deck_matchup_plans','deck_matchup_swaps','rifter_deck_state') THEN
     RAISE EXCEPTION 'Unsupported history entity'; END IF;
   EXECUTE format('SELECT to_jsonb(t) FROM %I t WHERE id=$1 FOR UPDATE',ch.entity) INTO current_row USING ch.row_id;
   -- Reauthorize both the current scope and the scope to be restored. This
   -- also catches a collection's owner changing without a copy-row update.
   FOREACH scope_row IN ARRAY ARRAY[current_row,ch.b] LOOP
     IF scope_row IS NULL THEN CONTINUE; END IF;
     scope_owner := rifter_owner(ch.entity,scope_row);
     IF scope_owner IS NULL THEN
       parent_entity := CASE WHEN ch.entity='copies' THEN 'collections' WHEN ch.entity='deck_matchup_swaps' THEN 'deck_matchup_plans' ELSE 'decks' END;
       parent_id := (CASE WHEN ch.entity='copies' THEN scope_row->>'collection_id' WHEN ch.entity='rifter_deck_state' THEN scope_row->>'id'
         WHEN ch.entity='deck_matchup_swaps' THEN scope_row->>'plan_id' ELSE scope_row->>'deck_id' END)::uuid;
       SELECT rifter_owner(parent_entity,coalesce(r.b,r.a)) INTO scope_owner FROM rifter_restore r WHERE r.entity=parent_entity AND r.row_id=parent_id;
       IF scope_owner IS NULL AND parent_entity='deck_matchup_plans' THEN
         SELECT rifter_owner('decks',coalesce(d.b,d.a)) INTO scope_owner FROM rifter_restore p JOIN rifter_restore d ON d.entity='decks'
           AND d.row_id=(coalesce(p.b,p.a)->>'deck_id')::uuid WHERE p.entity=parent_entity AND p.row_id=parent_id;
       END IF;
     END IF;
     IF scope_owner IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Ownership changed; this action cannot be reversed' USING ERRCODE='40001'; END IF;
   END LOOP;
   IF (current_row - 'updated_at' - 'updated_xid') IS DISTINCT FROM (ch.a - 'updated_at' - 'updated_xid') THEN
     RAISE EXCEPTION 'Later edits conflict with this action; undo newer dependent edits first' USING ERRCODE='40001';
   END IF;
   IF ch.b IS NULL AND ch.entity='collections' AND EXISTS(
     SELECT 1 FROM copies cp WHERE cp.collection_id=ch.row_id AND NOT EXISTS(
       SELECT 1 FROM rifter_restore r WHERE r.entity='copies' AND r.row_id=cp.id)
   ) THEN RAISE EXCEPTION 'Collection has later acquisitions; undo those first' USING ERRCODE='40001'; END IF;
   IF ch.b IS NULL AND ch.entity='decks' AND (
     EXISTS(SELECT 1 FROM deck_cards dc WHERE dc.deck_id=ch.row_id AND NOT EXISTS(SELECT 1 FROM rifter_restore r WHERE r.entity='deck_cards' AND r.row_id=dc.id))
     OR EXISTS(SELECT 1 FROM deck_plans dp WHERE dp.deck_id=ch.row_id AND NOT EXISTS(SELECT 1 FROM rifter_restore r WHERE r.entity='deck_plans' AND r.row_id=dp.id))
     OR EXISTS(SELECT 1 FROM deck_matchup_plans mp WHERE mp.deck_id=ch.row_id AND NOT EXISTS(SELECT 1 FROM rifter_restore r WHERE r.entity='deck_matchup_plans' AND r.row_id=mp.id))
   ) THEN RAISE EXCEPTION 'Deck has later edits; undo those first' USING ERRCODE='40001'; END IF;
   IF ch.b IS NULL AND ch.entity='deck_matchup_plans' AND EXISTS(
     SELECT 1 FROM deck_matchup_swaps ms WHERE ms.plan_id=ch.row_id AND NOT EXISTS(SELECT 1 FROM rifter_restore r WHERE r.entity='deck_matchup_swaps' AND r.row_id=ms.id)
   ) THEN RAISE EXCEPTION 'Matchup has later edits; undo those first' USING ERRCODE='40001'; END IF;
 END LOOP;
 -- Undo insertions, children first. Cascades may already remove a child.
 FOR ch IN SELECT * FROM rifter_restore WHERE b IS NULL ORDER BY CASE entity WHEN 'collections' THEN 4 WHEN 'decks' THEN 3 WHEN 'deck_matchup_plans' THEN 2 ELSE 1 END LOOP
   EXECUTE format('DELETE FROM %I WHERE id=$1',ch.entity) USING ch.row_id;
 END LOOP;
 -- Restore deletions and updates, parents before children.
 FOR ch IN SELECT * FROM rifter_restore WHERE b IS NOT NULL ORDER BY CASE entity WHEN 'collections' THEN 1 WHEN 'decks' THEN 2 WHEN 'deck_matchup_swaps' THEN 4 ELSE 3 END LOOP
   SELECT string_agg(quote_ident(key),','),string_agg('x.'||quote_ident(key),','),
     string_agg(quote_ident(key)||'=EXCLUDED.'||quote_ident(key),',')
   INTO columns_sql,values_sql,assignments FROM jsonb_object_keys(ch.b) key
   WHERE key NOT IN ('updated_xid','updated_at');
   EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_record(NULL::%I,$1) x ON CONFLICT(id) DO UPDATE SET %s',
      ch.entity,columns_sql,values_sql,ch.entity,assignments) USING ch.b;
 END LOOP;
 RETURN new_action;
END $$;
COMMIT;
