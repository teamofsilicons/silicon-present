alter table ting_outbox add column actor uuid;
alter table ting_outbox add column session_id text;
alter table ting_outbox drop constraint ting_outbox_state_check;
alter table ting_outbox add constraint ting_outbox_state_check
    check (state in ('pending', 'sent', 'failed', 'ting_not_configured', 'blocked'));

-- Never change a possibly accepted request's type/body under its existing key.
-- Keep legacy payloads for reconciliation against Ting's sent history.
update ting_outbox set state = 'failed', last_error = 'Legacy Ting type retired; reconcile sent history before deliberately resending with a new type and key.'
where state in ('pending', 'ting_not_configured') and type in (
    'present.mention.received', 'present.comment.created', 'present.comment.replied',
    'present.thread.resolved', 'present.deck.shared'
);

-- Addresses are created by our backend, never supplied by an API caller.
create table ting_library_sessions (
    session_id text primary key,
    owner uuid not null,
    expires_at timestamptz not null
);
create index ting_library_sessions_owner on ting_library_sessions(owner, expires_at);
