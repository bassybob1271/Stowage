# Stowage

A self-hosted, Dropbox-style file vault for **any storage backend**: S3-compatible object storage, IPFS, local disks/NAS, WebDAV, SFTP, Azure Blob, Google Cloud Storage, and — through rclone — anything rclone supports. Browse, upload (resumable), download, zip, and preview/play files in the browser.

> [!WARNING]
> **The default access code `42` is a demo gate, not real security.** A two-character code can be guessed. Before exposing Stowage beyond your own machine:
> 1. set `ACCESS_CODE` to a long random value,
> 2. serve it **only over TLS** (e.g. the bundled Caddy profile) and set `COOKIE_SECURE=true`,
> 3. keep the Kubo RPC port (5001) and your storage credentials private.
>
> Real authentication (OIDC/passkeys) plugs in behind the `AuthProvider` interface in `apps/server/src/auth.ts`.

## Quickstart (Docker)

```bash
cp deploy/.env.example deploy/.env
```

Fill in `SESSION_SECRET` and `MASTER_KEY` in `deploy/.env` (`openssl rand -hex 32` each) and change `S3_SECRET_KEY`. Then:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

Open <http://localhost:8787>, enter the access code, and you'll see three mounts: **S3** (bundled S3 server), **IPFS** (bundled Kubo node), and **Local disk**.

Optional profiles:

```bash
docker compose -f deploy/docker-compose.yml --profile tls up -d      # Caddy + automatic HTTPS (set DOMAIN)
docker compose -f deploy/docker-compose.yml --profile rclone up -d   # rclone catch-all backend
```

The compose file publishes the app on `127.0.0.1` only. Set `APP_BIND=0.0.0.0` (with TLS!) to expose it.

### Cloudflare Tunnel (public HTTPS, no open ports)

`cloudflared` makes outbound-only connections to Cloudflare, so the machine needs no inbound firewall rules. Your domain's DNS must be on Cloudflare (a free account is enough).

1. Change `ACCESS_CODE` to a long random value, then set `COOKIE_SECURE=true`, `TRUST_PROXY=true` and `APP_ORIGIN=https://files.example.com` in `deploy/.env`.
2. Authorize this machine once, which opens a Cloudflare link to approve in a browser, then create the tunnel and its DNS record:

   ```bash
   cd deploy && mkdir -p cloudflared && chmod 700 cloudflared
   docker run --rm -it -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/cloudflared:/tmp/.cloudflared" cloudflare/cloudflared:2026.11.1 tunnel login
   docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/cloudflared:/tmp/.cloudflared" cloudflare/cloudflared:2026.11.1 tunnel create stowage
   docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/cloudflared:/tmp/.cloudflared" cloudflare/cloudflared:2026.11.1 tunnel route dns stowage files.example.com
   ```

3. Write `deploy/cloudflared/native.yml`, using the tunnel ID that `create` printed and the absolute path of `deploy/cloudflared`:

   ```yaml
   tunnel: <TUNNEL-ID>
   credentials-file: /abs/path/to/deploy/cloudflared/<TUNNEL-ID>.json
   ingress:
     - hostname: files.example.com
       service: http://127.0.0.1:8787
     - hostname: live.example.com      # optional: apps/live streaming
       service: http://127.0.0.1:8790
     - service: http_status:404
   ```

4. Start it natively, along with the live service: `sh apps/live/scripts/run-native.sh`. The connector is a native binary (`pnpm --filter @stowage/live fetch-bins`), so one connector serves every hostname.

`deploy/cloudflared/` holds secrets (the account cert and tunnel credentials). It is gitignored; keep it `chmod 700`. If you created the tunnel in the Cloudflare dashboard instead, its token is base64 JSON `{a, t, s}`, which maps to a credentials file `{AccountTag, TunnelID, TunnelSecret}`. For a second login layer in front of the gate, add a Cloudflare Access application for the hostname: Zero Trust → Access → Applications → Self-hosted, with an **Allow** policy listing approved emails and the One-time PIN login method. Unauthenticated requests are then redirected to Cloudflare's sign-in before they reach Stowage.

## Development

Requires Node 22 and pnpm (`corepack enable`), plus Docker for the storage backends.

```bash
pnpm install
pnpm dev:infra        # S3 (RustFS + SeaweedFS), Kubo, rclone, SFTP, Azurite, fake-gcs on 127.0.0.1
cp deploy/.env.example .env   # set SESSION_SECRET, MASTER_KEY, COOKIE_SECURE=false, MOUNTS_FILE=./mounts.yaml
pnpm dev              # API on :8787 (tsx watch) + Vite on :5173 with HMR
```

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` across all packages (strict) |
| `pnpm test` | unit + API tests (Vitest), local-disk conformance |
| `pnpm test:infra` | the conformance suite against every backend from `pnpm dev:infra` |
| `pnpm e2e` | Playwright smoke test: log in with 42 → upload image/video/audio/pdf/md → preview each → seek video → download → delete, on **both** S3 and IPFS; plus HTML/SVG sandbox and refresh-resume tests |
| `pnpm build` | production build of every package |

`pnpm e2e` needs `pnpm dev:infra` running and fixtures generated once: `pnpm --filter @stowage/e2e fixtures`.

## Layout

```
apps/server        Hono API, auth gate, tus, thumbnails; serves the built web app
apps/web           React 19 + Vite + Tailwind + TanStack Query
packages/storage   StorageAdapter interface, emulation wrapper, all adapters, conformance suite
packages/shared    shared types, zod schemas, path guard, MIME map
deploy             Dockerfile, docker-compose (+ test backends), .env.example, mounts examples
docs/DECISIONS.md  every judgment call, with reasons
```

## Configuration

All configuration is environment variables validated at boot (the server exits with a list of problems if anything is wrong). See [`deploy/.env.example`](deploy/.env.example).

| Variable | Default | |
|---|---|---|
| `ACCESS_CODE` | `42` | Gate code (argon2id-hashed at boot, never sent to the client) |
| `SESSION_SECRET` | — required | ≥ 32 chars; signs session cookies and content links |
| `MASTER_KEY` | — required | 32-byte hex; AES-256-GCM key for mounts stored in the DB |
| `SESSION_TTL_DAYS` | `7` | Rolling session lifetime |
| `COOKIE_SECURE` | `true` | `false` only for plain-HTTP local use |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for rate limiting |
| `DATABASE_URL` | `file:./data/stowage.db` | SQLite, or `postgres://…` |
| `MOUNTS_FILE` | `./mounts.yaml` | Mount definitions (supports `${ENV}`) |
| `DATA_DIR` | `./data` | tus staging, thumbnail cache |
| `DIRECT_TRANSFER` | `false` | Presigned S3 URLs for downloads instead of proxying |
| `CONTENT_ORIGIN` | — | Separate origin for "open in new tab" content links |
| `MAX_UPLOAD_BYTES` | `0` (unlimited) | Per-file limit |
| `RECONCILE_INTERVAL_SEC` | `900` | Background index refresh |

## Mounts

Each mount is a top-level folder in the browser. Define them in `mounts.yaml` (values may reference `${ENV_VAR}` / `${ENV_VAR:-default}`), or add them in **Settings** in the UI — those are stored AES-GCM-encrypted with `MASTER_KEY`. Every mount accepts `readOnly: true`. A complete file with every adapter is in [`deploy/mounts.example.yaml`](deploy/mounts.example.yaml).

`GET /api/mounts` lists mounts with capabilities, emulated capabilities, and health.

### S3-compatible

```yaml
- id: r2
  kind: s3
  config:
    endpoint: https://<account>.r2.cloudflarestorage.com   # omit for AWS
    region: auto                 # AWS: us-east-1 etc.
    bucket: my-bucket
    accessKey: ${R2_ACCESS_KEY}
    secretKey: ${R2_SECRET_KEY}
    forcePathStyle: true         # default true when endpoint is set
    prefix: optional/sub/path    # root the mount inside the bucket
    publicEndpoint: https://...  # host used for presigned URLs (DIRECT_TRANSFER)
    createBucket: false          # create on first health check
    partSize: 16777216           # multipart part size
```

Uses `@aws-sdk/client-s3` + `lib-storage` (multipart streaming). Endpoints for common providers:

| Provider | Endpoint | Notes |
|---|---|---|
| AWS S3 | *(omit)* | `region` required |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `region: auto` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | use an application key |
| Wasabi | `https://s3.<region>.wasabisys.com` | |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` | |
| OCI Object Storage | `https://<ns>.compat.objectstorage.<region>.oraclecloud.com` | Customer Secret Keys, path style |
| Storj gateway | `https://gateway.storjshare.io` | |
| Filebase | `https://s3.filebase.com` | |
| Google Cloud Storage | `https://storage.googleapis.com` | HMAC interop keys |
| Garage / SeaweedFS / Ceph RGW / RustFS / MinIO | your endpoint | path style |

The adapter disables the newer default checksum headers that many S3-compatibles reject. **Tested** against RustFS and SeaweedFS in this repo (`pnpm test:infra`); point `S3_TEST_*` at R2/B2/AWS to run the same suite against a hosted provider.

### IPFS (Kubo RPC)

```yaml
- id: ipfs
  kind: ipfs
  config:
    apiUrl: http://kubo:5001        # never expose publicly
    gatewayUrl: http://kubo:8080    # optional, used for reads (Range-capable)
    mfsRoot: /stowage               # folder hierarchy lives in MFS
    authorization: Basic …          # optional, if your RPC is behind auth
```

Uploads are added as CIDv1 (raw leaves), pinned, and linked into MFS; every file's stat carries its **CID**, shown in the previewer and via **Show CID** in the context menu. "Overwrite" produces a new CID and repoints the MFS entry.

### IPFS pinning services

Add remote pinning (IPFS Pinning Service API — Pinata, Filebase, 4EVERLAND, …) to any IPFS mount:

```yaml
    pinning:
      endpoint: https://api.pinata.cloud/psa
      token: ${PINNING_TOKEN}
      required: false   # true = fail the upload if the remote pin fails
```

### Local filesystem

```yaml
- id: nas
  kind: local
  config: { root: /mnt/nas }
```

Path-jailed (including symlink escapes). Writes are atomic (temp file + rename).

### WebDAV (Nextcloud, ownCloud, Synology…)

```yaml
- id: nextcloud
  kind: webdav
  config:
    url: https://cloud.example.com/remote.php/dav/files/<user>
    username: <user>
    password: ${NEXTCLOUD_APP_PASSWORD}
    root: optional/sub/folder
    rangeRead: true    # set false if your server ignores Range (the wrapper emulates)
```

### SFTP

```yaml
- id: server
  kind: sftp
  config: { host: server.example.com, port: 22, username: me, privateKeyPath: /secrets/id_ed25519, root: /srv/files }
```

`password`, `privateKey` (inline) and `passphrase` are also accepted.

### Azure Blob

```yaml
- id: azure
  kind: azure
  config: { connectionString: ${AZURE_STORAGE_CONNECTION_STRING}, container: stowage, prefix: optional }
```

Or `account` + `accountKey` (+ `endpoint` for Azurite/sovereign clouds).

### Google Cloud Storage

```yaml
- id: gcs
  kind: gcs
  config: { bucket: my-bucket, projectId: my-project, keyFilename: /secrets/gcs.json }
```

Native SDK. Alternatively use the **S3 adapter** with GCS HMAC keys and `endpoint: https://storage.googleapis.com`.

### rclone — anything rclone supports

One adapter for 70+ backends: Google Drive, OneDrive, Dropbox, Box, Mega, pCloud, Proton Drive, Sia, Storj (native), and more. Run `rclone serve webdav <remote>:` (the compose `rclone` profile does this; put remotes in `deploy/rclone/rclone.conf`) and mount it:

```yaml
- id: gdrive
  kind: rclone
  config:
    url: http://rclone:8080
    rcUrl: http://rclone:5572   # optional: rclone RC for health/version
```

## Previews

Click any file for a full-screen previewer (←/→ for prev/next, Esc to close). Renderers are lazy-loaded through a registry (`apps/web/src/previewers/registry.ts`):

| Type | Renderer |
|---|---|
| Images (jpg, png, gif, webp, avif, bmp, ico, svg, heic) | zoom/pan, EXIF panel; HEIC via heic2any; SVG only via `<img>` |
| Video (mp4, webm, mov, ogv, m4v, m3u8) | Range-seekable `<video>`, speed, PiP, sibling `.vtt`/`.srt` subtitles, HLS via hls.js |
| Audio (mp3, m4a, aac, wav, ogg, opus, flac, weba) | waveform, folder-as-playlist, queue, shuffle/repeat, persistent mini-player |
| PDF | pdf.js with range loading, page thumbnails, text search, zoom |
| Text / code | Monaco (read-only; **Edit** saves back on writable mounts) |
| Markdown | marked + DOMPurify, raw/rendered toggle |
| CSV / TSV | streamed parse, virtualized sortable table |
| JSON | collapsible tree / raw |
| Zip | central directory via Range reads; preview single entries |
| Fonts | specimen |
| docx / xlsx | best-effort client render |
| anything else | info card + download |

Text previews cap at 5 MB; media streams without a cap. Grid view shows server-generated thumbnails for images, video (frame at 10%), PDF (page 1) and audio cover art.

## Keyboard

↑/↓ (←/→ in grid) move · Shift extends · Enter opens · Space quick-look · Delete deletes · F2 renames · ⌘/Ctrl+A selects all · Backspace goes up a folder · Esc clears.

## Security notes

- The gate is rate-limited per IP (5 failures/minute, then exponential backoff to 1 h); failures are logged. Every `/api/*` route except `/api/auth/*` and `/api/health` requires the session.
- Session cookies are signed, `HttpOnly`, `SameSite=Lax`, and `Secure` by default; mutations also check `Origin`.
- **User content can't script the app.** All file responses carry `Content-Security-Policy: sandbox` + `nosniff`; SVG is only rendered via `<img>`; Markdown/Office HTML is sanitized with DOMPurify. For the strongest isolation set `CONTENT_ORIGIN` to a separate subdomain. Covered by `apps/server/test/api.test.ts` and the e2e suite.
- Mount credentials added through the UI are encrypted at rest (AES-256-GCM, `MASTER_KEY`). Credentials in `mounts.yaml` should come from `${ENV}` references.
- Keep Kubo's RPC (`5001`) private — it is admin access to the node. The compose file never publishes it.

## Roadmap (after v1)

Share links · global + full-text search · version history · client-side E2E encryption · desktop sync + WebDAV server · cross-mount copy/move jobs · multi-user + ACLs · cross-mount dedup. See `CLAUDE.md` §6.
