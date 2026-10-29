-- Custom themes belong to an account and can be used in any deck it can edit. A theme is a copy: saving one from a
-- deck (or adding a shared deck's theme) snapshots its fonts and colours, and keeps its own copies of uploaded fonts.
create table themes (
    id         text primary key,
    owner      uuid not null,
    name       text not null check (length(name) between 1 and 80),
    theme      jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index themes_owner_name on themes (owner, lower(name));

-- Uploaded fonts a theme carries (bytes under PRESENT_DATA_DIR/theme-fonts/<id>); copied into a deck when it is used.
create table theme_fonts (
    id           text primary key,
    theme        text not null references themes (id) on delete cascade,
    family       text not null,
    filename     text not null,
    content_type text not null,
    size         bigint not null,
    sha256       text not null,
    created_at   timestamptz not null default now()
);
create index theme_fonts_theme on theme_fonts (theme);
