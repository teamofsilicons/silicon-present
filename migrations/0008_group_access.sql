CREATE TABLE group_access (
    resource_kind text NOT NULL CHECK (resource_kind IN ('deck','folder')),
    resource_id text NOT NULL,
    principal text NOT NULL,
    name text NOT NULL,
    role text NOT NULL CHECK (role IN ('viewer','commenter','editor')),
    PRIMARY KEY (resource_kind, resource_id, principal)
);
CREATE INDEX group_access_by_principal ON group_access(principal,resource_kind,resource_id);
