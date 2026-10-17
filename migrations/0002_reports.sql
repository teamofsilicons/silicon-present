-- Reports from Carbons and Silicons (`present report`): kept here and mailed to the team.
create table reports (
    id           text primary key,
    account      uuid not null,
    message      text not null,
    pr           text,
    context      jsonb not null default '{}',
    app_version  text not null,
    client       text,
    created_at   timestamptz not null default now()
);
create index reports_account on reports (account, created_at);

-- The service reads timestamps as time::OffsetDateTime, which can't hold ±infinity (decoding one panics), so no
-- timestamp may be infinite. accounts.refreshed_at was the only one with a non-now() default.
update accounts set refreshed_at = 'epoch' where not isfinite(refreshed_at);
alter table accounts add constraint accounts_refreshed_at_finite check (isfinite(refreshed_at));
