create extension if not exists citext;

create table users (
    id             uuid primary key default gen_random_uuid(),
    email          citext not null unique,
    name           text not null check (length(name) between 1 and 60),
    color          text not null,
    password_hash  text not null,
    created_at     timestamptz not null default now()
);

-- Only a hash of the session token is stored, so a database leak doesn't hand out live sessions.
create table sessions (
    token_hash  text primary key,
    user_id     uuid not null references users on delete cascade,
    expires_at  timestamptz not null
);
create index sessions_user on sessions (user_id);

create table documents (
    id          uuid primary key default gen_random_uuid(),
    title       text not null default '',
    owner_id    uuid not null references users on delete cascade,
    state       bytea,                         -- the whole Yjs document, as one update
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table members (
    document_id  uuid not null references documents on delete cascade,
    user_id      uuid not null references users on delete cascade,
    role         text not null check (role in ('owner', 'editor', 'viewer')),
    added_at     timestamptz not null default now(),
    primary key (document_id, user_id)
);
create index members_user on members (user_id);

-- A share link. The token is in the link; only its hash is kept here.
create table share_links (
    token_hash   text primary key,
    document_id  uuid not null references documents on delete cascade,
    role         text not null check (role in ('editor', 'viewer')),
    created_by   uuid not null references users on delete cascade,
    created_at   timestamptz not null default now(),
    revoked_at   timestamptz
);
create index share_links_document on share_links (document_id);

create table versions (
    id           bigserial primary key,
    document_id  uuid not null references documents on delete cascade,
    label        text,                          -- null for automatic snapshots
    state        bytea not null,
    created_by   uuid references users on delete set null,
    created_at   timestamptz not null default now()
);
create index versions_document on versions (document_id, created_at desc);
