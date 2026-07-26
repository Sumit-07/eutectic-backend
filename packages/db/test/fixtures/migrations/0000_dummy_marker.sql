-- Test fixture. NOT a real migration — it lives outside migrations/ on purpose,
-- because that directory ships 0000_extensions.sql and nothing else until M0-BE-02.
--
-- Deliberately NOT idempotent: no IF NOT EXISTS, and the INSERT has no guard. If
-- the runner ever applied it twice the second run would either error on the
-- duplicate table or leave two marker rows. That is the point — the exactly-once
-- guarantee is proven by this file's fragility, not by its tolerance.

CREATE TABLE migration_marker (
  id      integer PRIMARY KEY,
  note    text NOT NULL
);

INSERT INTO migration_marker (id, note) VALUES (1, 'applied by 0000_dummy_marker');
