# Google Drive connect: setup and limits

Developer doc. Students connect their own Google account (read-only Drive) so Polya can bring in
course files that are shared only with their school's Google accounts, such as Data 100's
"Anyone at UC Berkeley with the link" slides on `ds100.org/fa26`. A service account can't read
those files, because it isn't a member of the school's Google domain.

## How it fits together

- **The grant is the platform's, not Polya's.** One `google_tokens` row per user with
  `grant_kind = 'drive'`, shared with the Scope extension's `google-drive-connect`. Both tokens
  are AES-256-GCM ciphertext under `POLYA_TOKEN_KEY`, and the table is service-role only.
  Connecting Drive in Polya or in the extension connects both. Disconnecting in either one
  disconnects both, and the Polya card says so.
- **Gate:** feature flag `google_drive_full_read` (`feature_flags` + `feature_flag_allowlist`).
  It's in `allowlist` mode today. Students who aren't listed see "Google Drive isn't available
  for your account yet."
- **Audit:** every server-side file read writes a `google_drive_audit` row (`client = 'polya'`)
  before it happens. If the row can't be written, the read doesn't happen.
- **No migration.** Polya writes rows in these platform tables and never alters them
  (CLAUDE.md rule 5). Schemas: `lectra-ios/backend/migrations/20260924035718_google_tokens.sql`
  (plus `_ciphertext_columns` and `_drop_plaintext`) and `20260924052126_google_drive_audit.sql`.

| Piece | File |
|---|---|
| Card with Connect / Disconnect | `src/components/ConnectGoogleDrive.tsx` |
| Start: PKCE + state cookie, redirect to Google | `src/app/auth/google-drive/start/route.ts` |
| Callback: check state, hand the code to the edge function | `src/app/auth/google-drive/callback/route.ts` |
| Pure flow helpers (PKCE, cookie, results) | `src/lib/google-drive-connect.ts` |
| `status` / `connect` / `disconnect` | `supabase/functions/polya-google/index.ts` |
| Grant storage, flag check, revoke | `supabase/functions/_shared/drive-connection.ts` |
| Links, token calls, Drive reads (list, fetch, export) | `supabase/functions/_shared/drive.ts` |
| Import pump's reader (refresh, audit, student-facing errors) | `supabase/functions/_shared/drive-grant.ts` |

The browser never sees a Google token. It only sees the one-time authorization code on the
callback URL, and that code is useless without the PKCE verifier (in an httpOnly cookie) and the
client secret (edge env only).

## Secrets (edge-function env, names only)

| Name | What | Status |
|---|---|---|
| `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` | The "Scope Drive connect" **Web application** client in Google Cloud project `961806200943` (`canvascope-487203`) | Already set (Task 8.3, 2026-09-24) |
| `POLYA_TOKEN_KEY` | Token encryption key | Already set |

Never use `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` for Drive. In the shared
project those name the Supabase Google *sign-in* client, which `google-token-refresh` and
`google-calendar-read` use. Overwriting them breaks sign-in and Calendar. Next.js needs no new
env: the start route gets the public client id from `polya-google status`.

## Steps for Noel

1. **Use the existing project and client.** Don't create a new project or client. Google Cloud →
   project `961806200943` → Google Auth Platform → Clients → **Scope Drive connect**
   (`961806200943-coarkjcprccta4su3bp0mfjt8v3jbg9m`). The Google Drive API is already enabled in
   this project. The Drive API is free and limited only by quotas, so no billing account is
   needed for it.
2. **Add two authorized redirect URIs** to that client, exactly as written (no trailing slash):
   - `https://askpolya.com/auth/google-drive/callback`
   - `http://localhost:3000/auth/google-drive/callback`

   Keep the two `chromiumapp.org` URIs the extension uses. Adding `askpolya.com` can add it to
   Branding → Authorized domains. Afterwards, check that Verification Center still says
   verified, as you did when `chromiumapp.org` was added. An authorized domain on a verified app
   has to be verified in Search Console. If `askpolya.com` isn't verified there yet, setting
   `GOOGLE_SITE_VERIFICATION` in Vercel makes Polya emit the verification tag. If you serve
   Polya from another host (`www.`, a preview URL), add that host's callback too. Google rejects
   any redirect URI it doesn't have registered.
3. **Deploy `polya-google`** the way you deploy the other `polya-*` functions. It uses the
   default `verify_jwt = true`, so no `config.toml` entry is needed.
4. **Allowlist testers.** You're already on the list. To add someone, run this in the SQL editor
   with the email they sign in to *Polya* with (not necessarily their Drive account):

   ```sql
   insert into public.feature_flag_allowlist (flag_key, user_id, note)
   select 'google_drive_full_read', id, 'Polya Drive tester'
   from auth.users
   where email = 'student@berkeley.edu'
   on conflict (flag_key, user_id) do nothing;

   -- Who's on it:
   select u.email, a.note, a.added_at
   from public.feature_flag_allowlist a join auth.users u on u.id = a.user_id
   where a.flag_key = 'google_drive_full_read';
   ```

   To remove someone, delete their row. `polya-google` checks the flag on every `status` and
   `connect`, and the import reader checks it on every read, so a removal applies at once.
5. **Check the publishing status:** Google Auth Platform → Audience. The consent screen is
   verified for `calendar.events`, so it should say **In production**.
   - **In production (expected):** there's no Google test-user list to manage. Polya's
     allowlist is the gate. Grants don't expire after 7 days.
   - **Testing:** add each tester under Audience → Test users (up to 100). Their grants then
     expire 7 days after consent: the next import shows "Connect your school Google account"
     and they reconnect.
6. **Try it.** Your Berkeley account already holds a Drive grant from the extension (created
   2026-09-24, includes `drive.readonly`), so the card should say "Google Drive connected" right
   away. To test the whole flow, click Disconnect (this also disconnects the extension), then
   Connect, pick your berkeley.edu account, and allow Drive access. You should land back on the
   page with `?drive=connected`. The card only appears where the course-site flow mounts
   `<ConnectGoogleDrive />`.

## What students see while `drive.readonly` is unverified

`drive.readonly` is a **restricted** scope. Until Google verifies Polya's use of it:

- Google shows "Google hasn't verified this app". The student chooses **Advanced → Go to …
  (unsafe)**. The card's "Seeing a warning from Google?" note explains this.
- Google's consent screen has a checkbox per permission. If the student unticks Drive,
  `connect` revokes the partial grant and the page shows the "didn't get permission" message.
- An unverified app is capped at **100 users** for its unverified scopes. Polya's allowlist keeps
  you under that.

**Before anyone outside the allowlist can connect,** a public launch needs both of these:

1. **Restricted-scope verification:** Google Auth Platform → Data Access → add `drive.readonly`,
   then submit with a justification and a demo video. `noel_plan.md` already has this as an
   item after Phase 8.
2. **A CASA security assessment** (Cloud Application Security Assessment). It's done by an
   authorized third-party assessor, it's paid, and it has to be **renewed every year**. It's
   required because Polya's servers store the grant and read Drive content.

After both pass, set `google_drive_full_read` to `on`.

## Why `drive.readonly`, and the `drive.file` + Picker alternative

**Narrower scopes can't do this job:**

- `drive.metadata.readonly` lists files but can't download them.
- `drive.file` covers only files the app created, or files the user explicitly picked for this
  app (Google Picker or "Open with"). Course-staff files linked from a website are neither, so
  every read returns 404.
- `drive.readonly` reads anything the student's account can see. That's what an importer
  following links needs. The code never writes: every Drive call in `drive.ts` is a GET.

**Alternative (documented, not built): `drive.file` + Google Picker.**

| | `drive.readonly` (built) | `drive.file` + Picker |
|---|---|---|
| Google review | Restricted: verification + yearly CASA | Non-sensitive; already on the consent screen, no assessment |
| What Polya can read | Every linked file the student can see | Only files the student picked, one by one |
| Course-site import | Automatic: the crawler follows links | The student opens a picker and finds each file; new files each week need new picks |
| Folders | Listable and recursive | Picking a folder doesn't grant the files inside it |
| Extra setup | None beyond this doc | Picker API enabled, a browser API key, and a picker UI in Polya |

The Picker path suits "add this one file". It doesn't suit a course site that links dozens of
files and adds more weekly. It's the fallback if CASA isn't worth it, or if a school blocks
restricted scopes.

## Risk: the school's Google Workspace admin blocks the app

A Workspace admin (bConnected, at Berkeley) can stop unconfigured third-party apps from using
high-risk Drive scopes, including `drive.readonly`. Evidence so far: your berkeley.edu account
granted `drive.readonly` to this client on 2026-09-24, so Berkeley allowed it then. Policies
change, and they can differ per organizational unit (students vs staff).

**How to tell it happened.** Google's exact wording varies:

- On the consent screen: **"Access blocked: Your institution's admin needs to review
  \<app name\>"**, or **"\<app name\> is blocked"**, with **Error 400: admin_policy_enforced**.
  Google shows this instead of redirecting back, so Polya never sees a result.
- After a grant exists, Drive answers 403 `domainPolicy`. Imports then show "Your school doesn't
  let Polya open files from its Google Drive."

**Not the admin (fix it yourself):**

- "Google hasn't verified this app" with an Advanced link is expected. See above.
- "Access blocked: … has not completed the Google verification process" with **Error 403:
  access_denied**: the app is in Testing and this account isn't a test user (step 5).
- **Error 400: redirect_uri_mismatch**: the callback URI isn't registered on the client
  (step 2).

**Fallbacks, in order:**

1. If the block screen offers **Request access**, use it. The admin reviews the OAuth client id
   (`961806200943-coarkjcprccta4su3bp0mfjt8v3jbg9m`).
2. Ask bConnected (bConnected@berkeley.edu, 510-664-9000) to allow that client id for
   read-only Drive access. Expect a slow answer, or a no.
3. The `drive.file` + Picker path above. It's a non-sensitive scope, and admins block it less
   often.
4. Manual: the student downloads the files (File → Download → PDF, or Google Drive for desktop
   if the school allows it) and uploads them to Polya.

## Not verified yet

- No real consent → callback → `connect` round trip has run against Google. Only unit tests and
  type checks have run.
- `polya-google` isn't deployed. The new redirect URIs aren't registered.
- Listing a folder in a shared drive the student isn't a member of. It uses
  `includeItemsFromAllDrives` without `corpora=drive`; confirm on a real shared-drive link.
- The fallback for Docs exports over 10 MB (`exportLinks`) has only been tested with fakes.
