-- Test fixture. Second file, so ordering is actually exercised: this one depends
-- on the table 0000 created, and fails loudly if the runner reorders them.

INSERT INTO migration_marker (id, note) VALUES (2, 'applied by 0001_dummy_second');
