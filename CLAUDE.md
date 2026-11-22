# CLAUDE.md — Build a Multi-Backend Dropbox Clone ("Stowage")

You are building a self-hosted, Dropbox-style file vault. It stores files on **any compatible storage backend**: S3-compatible object storage first, then IPFS, then everything else practical. It runs in the browser behind an access code gate and gives users a file browser, upload/download, and in-browser preview and playback for common file types.

Work in the phases below, in order. Don't start a phase until the previous phase's acceptance checks pass. Commit at the end of each phase.

---

## 0. Ground rules

- **Language:** TypeScript everywhere, with `strict: true`. Node 22 LTS.
- **Monorepo:** pnpm workspaces.
  ```
  /apps/server     Hono API + static hosting of the built web app
  /apps/web        React 19 + Vite + Tailwind + TanStack Query
  /packages/storage  Storage adapter interface + all adapters
  /packages/shared   Shared types, zod schemas, MIME map
  /deploy          docker-compose, Dockerfile, sample .env
  ```
- **Metadata DB:** SQLite through Drizzle ORM by default. Keep the schema portable to Postgres (`DATABASE_URL` switches between them).
- **Streaming:** Never buffer whole files in memory. All uploads and downloads stream.
- **Config:** All config comes from env vars, validated with zod at boot. Fail fast with a clear message.
- **Tests:** Vitest for unit tests and Playwright for end-to-end tests. Every adapter passes the same shared conformance suite.
- **No secrets in the repo.** Ship `.env.example` only.

---

## 1. Access gate (code `42`)

The first screen is a single input that says **"Enter access code."** The code is `42`.

Requirements:
- The code comes from `ACCESS_CODE` (default `42`). Store and compare an **argon2id hash** with a constant-time compare. Never send the code to the client.
- On success, issue a signed, `HttpOnly`, `Secure`, `SameSite=Lax` session cookie (`SESSION_SECRET`, 7-day TTL, rolling).
- Rate-limit attempts per IP: 5 per minute, then exponential backoff. Log failed attempts.
- Every `/api/*` route except `/api/auth/*` and `/api/health` requires the session.
- Add a logout button in the header.
- Leave a hook for future real auth (OIDC/passkeys). Put the gate behind an `AuthProvider` interface so it can be swapped out later.
- **Put a README warning on this:** a two-character code is a demo gate, not real security. Tell users to change `ACCESS_CODE` and put the app behind TLS before exposing it.

Acceptance: wrong code → error plus backoff; `42` → file browser; direct API calls without the cookie → 401.

---

## 2. Storage abstraction (`/packages/storage`)

### 2.1 Interface

```ts
export interface StorageAdapter {
  readonly id: string;              // unique mount id
  readonly kind: AdapterKind;       // 's3' | 'ipfs' | 'local' | ...
  readonly capabilities: {
    list: boolean; rename: boolean; delete: boolean;
    rangeRead: boolean; multipartUpload: boolean;
    presignedUrls: boolean; contentAddressed: boolean; versioning: boolean;
  };

  list(prefix: string, opts?: { cursor?: string; limit?: number }): Promise<ListResult>;
  stat(path: string): Promise<FileStat | null>;
  read(path: string, range?: { start: number; end?: number }): Promise<ReadableStream<Uint8Array>>;
  write(path: string, body: ReadableStream<Uint8Array>, meta: WriteMeta): Promise<FileStat>;
  delete(path: string): Promise<void>;
  move?(from: string, to: string): Promise<void>;     // fall back to copy+delete
  mkdir?(path: string): Promise<void>;                // object stores: no-op / marker
  presignGet?(path: string, ttlSec: number): Promise<string>;
  presignPut?(path: string, ttlSec: number): Promise<string>;
  multipart?: MultipartOps;                           // init/part/complete/abort
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
```

- `FileStat` = `{ path, name, size, mime, etag?, cid?, modifiedAt, isDir }`.
- Paths are POSIX-style and relative to the mount root. Normalize them and **reject `..` traversal** in one shared helper.
- When a capability is missing, emulate it in a wrapper (`withEmulation(adapter)`). For example, emulate `move` as copy+delete, and emulate range reads by skipping bytes. Mark emulated capabilities in the UI.

### 2.2 Mounts

Users can configure **multiple mounts** at once. Each mount appears as a top-level folder in the browser (like `/s3-main`, `/ipfs`, `/nas`).

- Mounts are defined in `mounts.yaml`, or through the Settings UI and stored encrypted in the DB with AES-GCM under `MASTER_KEY`.
- Each mount has `{ id, label, kind, config, readOnly }`.
- `GET /api/mounts` lists mounts with their capabilities and health.

### 2.3 Adapters — build in this order

| # | Adapter | Notes |
|---|---|---|
| 1 | **S3-compatible** | `@aws-sdk/client-s3` + `lib-storage` for multipart. Config: endpoint, region, bucket, accessKey, secretKey, `forcePathStyle`. **Test against:** AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, OCI Object Storage (S3 compat endpoint), Storj gateway, Filebase, Garage, SeaweedFS, Ceph RGW. Use presigned PUT/GET for direct browser transfer when `DIRECT_TRANSFER=true`, otherwise proxy through the server. |
| 2 | **IPFS (Kubo RPC)** | Talk to a Kubo node over `/api/v0` (`add`, `cat` with offset/length, `files/*` MFS for a path hierarchy, `pin/add`). Folder structure lives in **MFS**, and each file stat carries its `cid`. Reads can also go through a configurable HTTP gateway. Content-addressed: "overwrite" makes a new CID and updates the MFS entry. |
| 3 | **IPFS pinning services** | IPFS Pinning Service API spec (Pinata, Filebase, 4EVERLAND, etc.) layered on the Kubo adapter, so uploads get pinned remotely. Optional per mount. |
| 4 | **Local filesystem** | Root dir plus path jail. Good for dev and NAS mounts. |
| 5 | **WebDAV** | Nextcloud, ownCloud, Synology, etc. |
| 6 | **SFTP** | `ssh2-sftp-client`. |
| 7 | **Azure Blob** | `@azure/storage-blob`. |
| 8 | **Google Cloud Storage** | Native SDK (GCS also works through the S3 adapter with HMAC keys; support both). |
| 9 | **rclone (catch-all)** | Run `rclone serve` (webdav/s3) or call the rclone RC API. This instantly unlocks 70+ backends: Google Drive, OneDrive, Dropbox, Box, Mega, pCloud, Proton Drive, Sia, Storj native, and more. Document it as "anything rclone supports." |
| 10 | **Arweave / Filecoin (optional)** | Write-once archival tier through a provider SDK. Read-only listing from an index the app maintains. Flag it as permanent and paid in the UI. |

Every adapter gets its own `README.md` section with config examples, and must pass `packages/storage/test/conformance.ts`: list/stat/read/range/write/delete/move, unicode names, 0-byte files, a file over 5 GB (multipart, skippable in CI), and concurrent writes.

### 2.4 Metadata index

- The `files` table caches listings: `mount_id, path, name, size, mime, etag, cid, modified_at, indexed_at`. The adapter stays the source of truth. Refresh on browse, with a background reconcile job.
- `shares` table: public link tokens with optional expiry and password (Phase 6).
- `uploads` table: resumable multipart session state.

---

## 3. API (`/apps/server`, Hono)

```
POST   /api/auth/login            { code }
POST   /api/auth/logout
GET    /api/health
GET    /api/mounts
GET    /api/fs/:mount/list?path=&cursor=
GET    /api/fs/:mount/stat?path=
GET    /api/fs/:mount/raw?path=          # streams, honors Range → 206, sets Content-Type, ETag, Accept-Ranges
GET    /api/fs/:mount/download?path=     # Content-Disposition: attachment
GET    /api/fs/:mount/zip?paths[]=       # streamed zip of folders/multi-select (archiver)
POST   /api/fs/:mount/upload             # streamed multipart/form-data, or tus endpoint below
POST   /api/fs/:mount/mkdir
POST   /api/fs/:mount/move               { from, to }
DELETE /api/fs/:mount?path=
GET    /api/fs/:mount/thumb?path=&w=     # cached thumbnails (sharp for images, ffmpeg frame for video)
ALL    /api/tus/*                        # resumable uploads (tus protocol, @tus/server)
GET    /api/fs/:mount/presign?path=&op=get|put
```

- **Range support is mandatory**, because video/audio seeking and PDF.js depend on it.
- Send a correct `Content-Type` from a shared MIME map. Set `X-Content-Type-Options: nosniff`.
- **Serve user content safely:** set a CSP sandbox on `/raw` responses (`Content-Security-Policy: sandbox`) so uploaded HTML/SVG can't run script against the app origin. Use a separate `CONTENT_ORIGIN` subdomain when one is configured.
- Size limits come from config. Default is unlimited with multipart/tus.

---

## 4. Web app (`/apps/web`)

### 4.1 Layout

- **Header:** app name, search box (filters the current folder; global search over the index is a Phase 6 item), upload button, logout.
- **Left sidebar:** mounts with health dots, plus Recent and Starred (local).
- **Main pane:** breadcrumb, list/grid toggle, and sortable columns (name, size, modified, type). Multi-select with checkbox and shift-click. Right-click context menu: Open, Download, Rename, Move, Delete, Copy link, Show CID (IPFS).
- **Drag-and-drop** files *and folders* onto the pane to upload. Folders use `webkitGetAsEntry` to recurse.
- **Upload tray** in the bottom-right corner shows per-file progress, speed, pause/resume/cancel, and retries. Use tus or S3 multipart so a refresh doesn't lose progress.
- Keyboard: arrows to move, Enter to open, Space for quick-look, Delete, F2 to rename, Ctrl/Cmd+A to select all.
- Responsive: usable on a phone. On mobile, the sidebar collapses into a drawer.
- Dark/light mode follows the system setting.

### 4.2 Preview and playback

Clicking a file opens a **full-screen previewer** with prev/next through the folder, download, and close (Esc). Choose the renderer by MIME type and extension:

| Category | Types | Renderer |
|---|---|---|
| Images | jpg, jpeg, png, gif, webp, avif, bmp, ico, svg, heic (decode with `heic2any`) | `<img>` with zoom/pan, EXIF panel; SVG in a sandboxed `<img>`, never inline |
| Video | mp4, webm, mov (H.264), ogv, m4v; HLS `.m3u8` with `hls.js` | `<video>` with seek (Range), playback speed, PiP, subtitles if a sibling `.vtt`/`.srt` exists |
| Audio | mp3, m4a, aac, wav, ogg, oga, opus, flac, weba | Custom player with waveform (`wavesurfer.js`), **folder-as-playlist**, queue, shuffle/repeat, and a persistent mini-player that keeps playing while browsing |
| PDF | pdf | PDF.js (`pdfjs-dist`) with page thumbnails, search, zoom |
| Text / code | txt, log, md, json, yaml, toml, xml, ini, csv, tsv, js, ts, py, go, rs, java, c, cpp, sh, sql, html, css, and more | Monaco (read-only, with an "Edit" toggle that saves back if the mount is writable) |
| Markdown | md | Rendered with `marked` + DOMPurify, with a raw/rendered toggle |
| Tabular | csv, tsv | Virtualized table (`papaparse` + TanStack Table) |
| Data | json | Collapsible tree view |
| Office (optional) | docx (`mammoth`), xlsx (`SheetJS`), pptx (thumbnail fallback) | Client-side best-effort render |
| Archives | zip | List contents with `@zip.js/zip.js` using range reads; preview single entries |
| 3D (optional) | glb, gltf, stl, obj | `<model-viewer>` / three.js |
| Fonts | ttf, otf, woff, woff2 | Specimen render |
| Unknown | — | File info card + download button |

Put every renderer behind a registry: `registerPreviewer({ match(mime, ext), component, maxSize })`. Lazy-load each renderer with dynamic `import()` so the initial bundle stays small. Above `maxSize`, show "Too large to preview — download." Text has a 5 MB cap; media has no cap because it streams.

### 4.3 Thumbnails

Grid view shows thumbnails for images, video (frame at 10%), PDF (page 1), and audio (embedded cover art through `music-metadata`). Generate them on the server and cache them in a local or configured cache bucket, keyed by etag/cid.

---

## 5. Deploy (`/deploy`)

- A multi-stage `Dockerfile` that produces one image serving both the API and the static web app.
- `docker-compose.yml` with:
  - `app`
  - `minio` (S3 dev target, with an auto-created bucket)
  - `kubo` (IPFS node, RPC port **not** published publicly)
  - optional `rclone` service
  - optional `caddy` for automatic TLS
- `.env.example` with `ACCESS_CODE=42`, `SESSION_SECRET`, `MASTER_KEY`, `DATABASE_URL`, `DIRECT_TRANSFER`, `CONTENT_ORIGIN`, and per-mount sample vars.
- `pnpm dev` runs everything locally with hot reload against MinIO and Kubo.
- One-command smoke test: `pnpm e2e` (Playwright): log in with 42 → upload image/video/audio/pdf/md → preview each → seek video → download → delete, on **both** the S3 and IPFS mounts.

---

## 6. Later phases (after v1 ships)

1. Public share links (expiry, password, download count).
2. Global search over the index, then full-text search of text/PDF content (SQLite FTS5).
3. Version history (S3 versioning; IPFS gives it free through old CIDs).
4. Client-side end-to-end encryption option per mount (age/WebCrypto). Note in the UI that previews then happen only client-side.
5. Desktop sync client (Tauri) and a WebDAV *server* endpoint so the OS can mount the vault.
6. Cross-mount copy/move (S3 → IPFS and so on) as background jobs with progress.
7. Multi-user accounts and per-mount ACLs, replacing the code gate.
8. Dedup by content hash across mounts.

---

## 7. Definition of done for v1

- [ ] Code `42` gate works, is rate-limited, and the session cookie is secure
- [ ] S3 adapter passes conformance against MinIO + at least one hosted provider (R2 or B2)
- [ ] IPFS adapter passes conformance against Kubo; CIDs visible in the UI
- [ ] Local, WebDAV, and rclone adapters pass conformance
- [ ] Browse, create folder, rename, move, delete, multi-select, zip download
- [ ] Resumable uploads survive a page refresh
- [ ] Previews work for every row in the 4.2 table except the "optional" ones
- [ ] Video and audio seek instantly (Range verified); audio mini-player persists across navigation
- [ ] User HTML/SVG cannot execute script on the app origin (test included)
- [ ] `docker compose up` gets to a working app in under 2 minutes on a clean machine
- [ ] README: quickstart, mount configuration examples for every adapter, security notes

When something here is ambiguous, pick the simplest option that keeps the adapter interface clean, write the decision down in `docs/DECISIONS.md`, and keep going.
