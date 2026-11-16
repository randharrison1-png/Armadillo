-- Task 11: bring-your-own Claude API key storage.
--
-- profiles.claude_key_ciphertext / claude_key_last4 are not writable by `authenticated` (column
-- grants in 0001), and the ciphertext is not even readable. Server code changes them only through
-- these SECURITY DEFINER functions, each of which acts on auth.uid()'s own row and nothing else.
-- The browser never calls them: they run inside withUser() transactions on the server, which
-- encrypts the key (AES-256-GCM, src/server/security/crypto.ts) before it ever reaches SQL. The
-- plaintext key never enters the database.

-- Stores an encrypted key and its last four characters for the calling user.
create or replace function public.set_claude_key(p_cipher text, p_last4 text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'set_claude_key requires an authenticated user' using errcode = '28000';
  end if;
  -- Only versioned ciphertexts (v1:<iv>:<tag>:<ct>, base64url) are accepted: a plaintext key
  -- passed here by mistake is refused instead of stored.
  if p_cipher is null or char_length(p_cipher) > 4000
    or p_cipher !~ '^v[0-9]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$' then
    raise exception 'invalid key ciphertext' using errcode = '22023';
  end if;
  if p_last4 is null or char_length(p_last4) <> 4 then
    raise exception 'invalid key suffix' using errcode = '22023';
  end if;

  update public.profiles
     set claude_key_ciphertext = p_cipher, claude_key_last4 = p_last4
   where id = v_uid;
  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Removes the calling user's key.
create or replace function public.clear_claude_key()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'clear_claude_key requires an authenticated user' using errcode = '28000';
  end if;
  update public.profiles
     set claude_key_ciphertext = null, claude_key_last4 = null
   where id = v_uid;
end;
$$;

-- The calling user's encrypted key (null when none). Only server code decrypts it, per request.
create or replace function public.get_claude_key_ciphertext()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_cipher text;
begin
  if v_uid is null then
    raise exception 'get_claude_key_ciphertext requires an authenticated user' using errcode = '28000';
  end if;
  select p.claude_key_ciphertext into v_cipher from public.profiles p where p.id = v_uid;
  return v_cipher;
end;
$$;

-- EXECUTE for authenticated only. Supabase grants EXECUTE on new public functions to PUBLIC, anon,
-- authenticated and service_role by default; take it back from everything but authenticated.
revoke execute on function public.set_claude_key(text, text) from public, anon, service_role;
revoke execute on function public.clear_claude_key() from public, anon, service_role;
revoke execute on function public.get_claude_key_ciphertext() from public, anon, service_role;
grant execute on function public.set_claude_key(text, text) to authenticated;
grant execute on function public.clear_claude_key() to authenticated;
grant execute on function public.get_claude_key_ciphertext() to authenticated;
