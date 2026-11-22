# Decisions

Where the spec was ambiguous or reality intervened, we took the simplest option that keeps the adapter interface clean. Newest last.

## Platform

1. **MinIO → RustFS for the S3 dev target.** MinIO stopped publishing community images to Docker Hub in late 2025 (`minio/minio` and `minio/mc` now 404, and Quay requires login). The compose service is still named `minio` so endpoints and docs are unchanged, but it runs `rustfs/rustfs` (MinIO-compatible, Apache-2.0). The conformance suite also runs against **SeaweedFS**, which is on the spec's provider list. Swap the image back if you have a MinIO subscription image.
2. **No `mc` bucket bootstrap.** The S3 adapter gained `createBucket: true`, which creates the bucket on the first health check. This removes the init container.
3. **pnpm 12** is pinned with `packageManager`. Its `allowBuilds` list in `pnpm-workspace.yaml` names the native modules that may run install scripts. `cpu-features` (an optional ssh2 speedup that needs a compiler) is denied.
4. **zod 3**, not zod 4, to keep `z.record(z.unknown())` and the error formatting stable. Upgrading is mechanical.

## Storage

5. **Paths.** A single helper, `normalizePath` in `@stowage/shared`, normalizes every path at the emulation boundary. It **rejects** any `..` segment and NUL bytes and never resolves them. The local adapter also has a symlink-aware jail.
6. **Directory semantics.** `delete(dir)` is recursive. `mkdir` writes a zero-byte `prefix/` marker on object stores (S3, Azure, GCS) so empty folders show up. Listings hide markers.
7. **Emulation wrapper** (`withEmulation`). It provides `move` as copy+delete (recursive), range reads by skipping bytes, `mkdir` as a no-op when an adapter lacks it, and read-only enforcement. Emulated capabilities are listed in `MountInfo.emulated` and shown in the UI. Every adapter implements native `move` today, so `emulated` is usually empty. The fallbacks are still exercised by the code paths.
8. **Same-path write serialization.** Azure block lists and WebDAV locks reject overlapping uploads to one name. The wrapper serializes writes per path within the process, last writer wins. Cross-process races depend on the backend.
9. **WebDAV writes** PUT to a hidden temp name and then MOVE into place. Readers see atomic replacement, and the bodiless MOVE can be retried on `423 Locked` (rclone holds a lock briefly after writes). Concurrent `MKCOL` races are tolerated when the folder exists afterwards.
10. **rclone adapter = WebDAV to `rclone serve webdav`**, plus an optional RC health check. We picked WebDAV over `rclone serve s3` because it keeps empty folders and works for every rclone backend.
11. **IPFS.** Bytes are `add`ed as CIDv1 with raw leaves, pinned, then `files/cp`'d into MFS under `mfsRoot`. Overwrite creates a new CID and repoints the MFS entry. Delete removes the MFS link and our pin; the content stays retrievable by CID until GC. Range reads use `cat --offset/--length`, or the gateway when configured. MFS has no mtimes, so `modifiedAt` is the epoch.
12. **Remote pinning** follows the IPFS Pinning Service API spec directly, not Kubo's `pin/remote`, so no node-side service registration is needed. By default a failed remote pin is logged and the write succeeds; set `pinning.required: true` to fail the upload instead.
13. **S3 copies > 5 GB** (server-side move of huge objects) would need `UploadPartCopy`. This isn't implemented yet: `CopyObject` fails above 5 GB on AWS. Uploads > 5 GB work (multipart).
14. **Arweave/Filecoin** (optional row 10) is not built in v1.
15. **Large-file conformance** (>5 GB) is gated behind `CONFORMANCE_LARGE=1`, as the spec allows.

## Server

16. **Access code.** It is hashed with argon2id at boot (`@node-rs/argon2`, prebuilt binaries), and verification is constant-time. The plaintext lives only in the env.
17. **Sessions** are an HMAC-signed cookie (`hono/cookie` signed cookies) holding `{sub, iat, exp}`. It is `HttpOnly`, `SameSite=Lax`, and `Secure` unless `COOKIE_SECURE=false`, which the plain-http quickstart sets. The expiry rolls forward at most hourly. There is no server-side session store, so logout clears the cookie. Rotating `SESSION_SECRET` invalidates every session.
18. **Rate limit**: in-memory and per IP. Five failures in a minute trigger a lockout of 2 s, then 4 s, 8 s and so on, capped at 1 h. Success resets it. `TRUST_PROXY=true` reads `X-Forwarded-For`. Running multiple replicas would need a shared store.
19. **CSRF.** SameSite=Lax plus an Origin check on every state-changing `/api` request.
20. **User content isolation.** Every file response carries `Content-Security-Policy: sandbox; default-src 'none'; …` and `nosniff`. Sandboxed documents get an opaque origin and cannot run script. In the UI, SVG only ever renders through `<img>`. "Open in new tab" uses a short-lived signed, cookie-less URL (`/c/<token>/<name>`) served from `CONTENT_ORIGIN` when set.
21. **`/api/fs/:mount/file/<path>`** was added: a path-style alias of `/raw` so relative references (HLS `.m3u8` → segments) resolve to sibling files.
22. **`DIRECT_TRANSFER`**. Downloads of non-active content 302 to a presigned URL, and `/presign` is enabled. Uploads always use tus through the server, because that is the resumable path that survives refresh. Direct presigned multipart from the browser is a follow-up.
23. **tus**: `@tus/server` 2 with `FileStore` staging under `DATA_DIR/tus`. On the final chunk the assembled file streams into the mount. The `uploads` table mirrors session state for visibility; the tus sidecar JSON is the source of truth for offsets.
24. **Uploads** also accept streamed `multipart/form-data` (busboy) and raw bodies (`?path=`).
25. **DB.** One Drizzle schema per dialect with identical column names, plus idempotent `CREATE TABLE IF NOT EXISTS` at boot, so no migration tool is needed for v1. `DATABASE_URL=postgres://…` switches to Postgres.
26. **Thumbnails.** Images use sharp, audio covers use music-metadata, video frames come from ffmpeg (at 10% via a signed loopback URL, so ffmpeg can seek with Range), and PDF page 1 comes from poppler's `pdftoppm`. ffmpeg and poppler are in the Docker image and optional elsewhere. Thumbnails are cached in `DATA_DIR/thumbs`, keyed by mount, path, etag/CID and width. Failures are cached as empty files.
27. **Search** (`/api/search`) does a LIKE over the cached index. This is Phase 6.2's first step; FTS is later.

## Web

28. **No router library.** A ~40-line `history` router handles `/browse/<mount>/<path>?open=<file>`.
29. **Resumable after refresh.** File handles are kept in IndexedDB; Chromium, Firefox and Safari support structured-cloning `File`. On reload, unfinished uploads come back and resume via the tus fingerprint, then HEAD and the saved offset. If a handle can't be restored, the tray asks you to re-select the file and matches it by name and size.
30. **Audio** plays through one global `<audio>` element outside the route tree, so it keeps playing during navigation. The waveform (wavesurfer) uses a separate muted element mirrored to the global player's position, and is skipped above 60 MB.
31. **Monaco** is bundled and self-hosted (no CDN) and lazy-loaded with the code viewer. Only the base editor worker is used, which is enough for read-only and light editing.
32. **Office**: `.docx` via mammoth, `.xlsx`/`.ods` via SheetJS (installed from the SheetJS CDN tarball, because the npm `xlsx` package is stale). Both outputs pass through DOMPurify. pptx and 3D (optional rows) fall back to the info card.
33. **e2e** runs in real Google Chrome when it's installed (`E2E_CHANNEL` overrides), because Playwright's Chromium lacks H.264/AAC.
34. **Docker quickstart timing.** Measured on an Apple-silicon Mac (8 CPUs) with the build cache pruned and the `node:22-alpine` base image removed: `docker compose up -d --build` reached a healthy `/api/health` in **92 s**. The image is 662 MB, mostly ffmpeg and poppler. The RustFS and Kubo images were already local for that run, so a truly clean machine adds their pull time. Publishing the image (`image: ghcr.io/<you>/stowage`) removes the build step entirely.
