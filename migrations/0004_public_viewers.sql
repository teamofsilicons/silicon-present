-- An email is an explicitly self-reported visitor label, never an access grant.
alter table decks add column public_require_email boolean not null default false;

create table deck_viewers (
    deck text not null references decks(id) on delete cascade,
    email text not null check (length(email) between 3 and 254),
    source text not null check (source in ('account', 'entered')),
    first_viewed_at timestamptz not null default now(),
    last_viewed_at timestamptz not null default now(),
    last_counted_at timestamptz not null default now(),
    views bigint not null default 1 check (views > 0),
    primary key (deck, email, source)
);
create index deck_viewers_last_viewed on deck_viewers(deck, last_viewed_at desc);
