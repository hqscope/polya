-- Encrypt Canvas access tokens at rest.
-- Edge functions hold the key (POLYA_TOKEN_KEY env, AES-256-GCM); the database
-- stores only ciphertext. `access_token` goes nullable so new rows can omit the
-- plaintext entirely; legacy plaintext rows are re-encrypted lazily on first
-- read (see _shared/connections.ts) and their plaintext column nulled.
alter table public.polya_canvas_connections
  add column if not exists access_token_ciphertext text,
  add column if not exists key_version integer;

alter table public.polya_canvas_connections
  alter column access_token drop not null;

comment on column public.polya_canvas_connections.access_token_ciphertext is
  'base64(12-byte IV || AES-256-GCM ciphertext+tag), key in edge-function env only';
comment on column public.polya_canvas_connections.access_token is
  'legacy plaintext; nulled after lazy re-encryption — do not write';
