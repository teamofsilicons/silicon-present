-- Consent is per Present account. Silicon Contacts retains the address book.
CREATE TABLE contacts_connections (
    account uuid PRIMARY KEY,
    connected_at timestamptz NOT NULL DEFAULT now()
);
