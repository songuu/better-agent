CREATE TABLE migration_probe (
    id integer PRIMARY KEY,
    applied_once text NOT NULL
);

INSERT INTO migration_probe (id, applied_once)
VALUES (1, 'first-application');
