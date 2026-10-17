-- Silicon Present: everything the service stores. Content lives in deck_updates (append only); everything else
-- (titles, owners, folders, sharing, trash, comments) lives in these tables.

-- Carbons and Silicons, by their Silicon Accounts uuid. A cache of how they are shown, refreshed from Accounts.
create table accounts (
    uuid           uuid primary key,
    handle         text not null default '',          -- c:ada / si:writer at last refresh
    kind           text not null default 'carbon' check (kind in ('carbon', 'silicon')),
    display_name   text not null default '',
    pfp_url        text not null default '',
    email          text,                              -- lowercase, from Accounts when the account shares it
    refreshed_at   timestamptz not null default 'epoch',
    ting_enrolled_at timestamptz,
    created_at     timestamptz not null default now()
);
create index accounts_handle on accounts (lower(handle));
create index accounts_email on accounts (email) where email is not null;

create table folders (
    id           text primary key,
    owner        uuid not null,
    creator      uuid not null,
    name         text not null,
    parent       text references folders (id) on delete cascade,
    public_mode  text not null default 'off' check (public_mode in ('off', 'view', 'comment', 'edit')),
    trashed_at   timestamptz,
    trashed_by   uuid,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index folders_owner on folders (owner);
create index folders_parent on folders (parent);

create table decks (
    id           text primary key,
    owner        uuid not null,
    creator      uuid not null,
    title        text not null,
    folder       text references folders (id) on delete cascade,
    public_mode  text not null default 'off' check (public_mode in ('off', 'view', 'comment', 'edit')),
    trashed_at   timestamptz,
    trashed_by   uuid,
    seq          bigint not null default 0,          -- the latest update's sequence number (the deck's version)
    search_text  text not null default '',            -- slide text, notes and table text, for search
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index decks_owner on decks (owner);
create index decks_folder on decks (folder);

-- Who may do what. Exactly one of account / email (a pending invite by email).
create table access (
    id             bigserial primary key,
    resource_kind  text not null check (resource_kind in ('deck', 'folder')),
    resource_id    text not null,
    account        uuid,
    email          text,
    role           text not null check (role in ('editor', 'commenter', 'viewer')),
    invited_by     uuid not null,
    created_at     timestamptz not null default now(),
    check ((account is null) <> (email is null))
);
create unique index access_account on access (resource_kind, resource_id, account) where account is not null;
create unique index access_email on access (resource_kind, resource_id, email) where email is not null;
create index access_by_account on access (account);
create index access_by_email on access (email) where email is not null;

-- The deck's content: every Yjs update, in order, with who made it. Never deleted while the deck exists.
create table deck_updates (
    deck        text not null references decks (id) on delete cascade,
    seq         bigint not null,
    data        bytea not null,
    author      uuid not null,
    origin      text not null check (origin in ('edit', 'ops', 'restore', 'import', 'create', 'undo')),
    summary     text,
    touched     text[] not null default '{}',
    created_at  timestamptz not null default now(),
    primary key (deck, seq)
);

-- The full Yjs state every 200 updates, to read old versions fast.
create table deck_snapshots (
    deck        text not null references decks (id) on delete cascade,
    seq         bigint not null,
    data        bytea not null,
    created_at  timestamptz not null default now(),
    primary key (deck, seq)
);

create table version_names (
    deck        text not null references decks (id) on delete cascade,
    seq         bigint not null,
    name        text not null,
    named_by    uuid not null,
    created_at  timestamptz not null default now(),
    primary key (deck, seq)
);

-- Everything that isn't content, shown in the history next to versions.
create table events (
    id          bigserial primary key,
    deck        text references decks (id) on delete cascade,
    folder      text references folders (id) on delete cascade,
    actor       uuid,
    kind        text not null,
    data        jsonb not null default '{}',
    created_at  timestamptz not null default now()
);
create index events_deck on events (deck, created_at);
create index events_folder on events (folder, created_at);

create table threads (
    id           text primary key,
    deck         text not null references decks (id) on delete cascade,
    anchor       jsonb not null,
    snapshot     jsonb not null,
    state        text not null default 'open' check (state in ('open', 'resolved')),
    created_by   uuid not null,
    resolved_by  uuid,
    resolved_at  timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index threads_deck on threads (deck, created_at);

create table comments (
    id          text primary key,
    thread      text not null references threads (id) on delete cascade,
    author      uuid not null,
    body        text not null,
    mentions    uuid[] not null default '{}',
    created_at  timestamptz not null default now(),
    edited_at   timestamptz,
    deleted_at  timestamptz,
    deleted_by  uuid
);
create index comments_thread on comments (thread, created_at);

-- Every earlier body of an edited or deleted comment, so nothing said is lost from the history.
create table comment_revisions (
    id          bigserial primary key,
    comment     text not null references comments (id) on delete cascade,
    body        text not null,
    replaced_by uuid not null,
    reason      text not null check (reason in ('edit', 'delete')),
    created_at  timestamptz not null default now()
);

create table reactions (
    comment     text not null references comments (id) on delete cascade,
    account     uuid not null,
    emoji       text not null,
    created_at  timestamptz not null default now(),
    primary key (comment, account, emoji)
);

create table assets (
    id            text primary key,
    deck          text not null references decks (id) on delete cascade,
    owner         uuid not null,
    uploaded_by   uuid not null,
    filename      text not null,
    content_type  text not null,
    size          bigint not null,
    sha256        text not null,
    created_at    timestamptz not null default now()
);
create index assets_deck on assets (deck);

create table transfers (
    id             text primary key,
    resource_kind  text not null check (resource_kind in ('deck', 'folder')),
    resource_id    text not null,
    from_account   uuid not null,
    to_account     uuid not null,
    state          text not null default 'pending' check (state in ('pending', 'accepted', 'declined', 'cancelled')),
    created_at     timestamptz not null default now(),
    decided_at     timestamptz
);
create index transfers_to on transfers (to_account, state);
create index transfers_from on transfers (from_account, state);
create unique index transfers_one_pending on transfers (resource_kind, resource_id) where state = 'pending';

create table presentations (
    id          text primary key,
    deck        text not null references decks (id) on delete cascade,
    presenter   uuid not null,
    slide       text,
    step        integer not null default 0,
    started_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    ended_at    timestamptz
);
create index presentations_deck on presentations (deck) where ended_at is null;

-- Tings waiting to be (or already) handed to Silicon Ting. The key makes every ting send at most once.
create table ting_outbox (
    id               bigserial primary key,
    idempotency_key  text not null unique,
    type             text not null,
    recipient        uuid not null,
    payload          jsonb not null,
    state            text not null default 'pending' check (state in ('pending', 'sent', 'failed', 'ting_not_configured')),
    attempts         integer not null default 0,
    next_attempt_at  timestamptz not null default now(),
    last_error       text,
    created_at       timestamptz not null default now(),
    sent_at          timestamptz
);
create index ting_outbox_due on ting_outbox (next_attempt_at) where state = 'pending';

-- Invite emails (to addresses with no Silicon Accounts account yet). Sent through Postmark when configured,
-- otherwise kept here and logged.
create table email_outbox (
    id               bigserial primary key,
    idempotency_key  text not null unique,
    to_email         text not null,
    subject          text not null,
    body             text not null,
    state            text not null default 'pending' check (state in ('pending', 'sent', 'failed', 'not_configured')),
    attempts         integer not null default 0,
    last_error       text,
    created_at       timestamptz not null default now(),
    sent_at          timestamptz
);

-- Responses to requests sent with an Idempotency-Key, so a retried request never acts twice.
create table idempotency_keys (
    account     uuid not null,
    key         text not null,
    method      text not null,
    path        text not null,
    status      integer not null,
    body        bytea not null,
    content_type text not null,
    created_at  timestamptz not null default now(),
    primary key (account, key)
);
