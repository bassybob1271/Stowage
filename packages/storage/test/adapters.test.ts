/**
 * Runs the conformance suite against every adapter whose test backend is
 * configured. `pnpm test:infra` (deploy/docker-compose.test.yml) starts all of them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConformance } from './conformance.js';
import {
  LocalAdapter,
  S3Adapter,
  IpfsAdapter,
  WebdavAdapter,
  RcloneAdapter,
  SftpAdapter,
  AzureBlobAdapter,
  GcsAdapter,
} from '../src/index.js';

const env = process.env;

runConformance('local', () => new LocalAdapter('local', { root: mkdtempSync(join(tmpdir(), 'stowage-conf-')) }));

// S3_TEST_* → RustFS, S3B_TEST_* → SeaweedFS (or point either at R2/B2/AWS for hosted runs).
for (const [label, pfx] of [
  ['s3/rustfs', 'S3_TEST'],
  ['s3/seaweedfs', 'S3B_TEST'],
] as const) {
  runConformance(
    label,
    () =>
      new S3Adapter(label, {
        endpoint: env[`${pfx}_ENDPOINT`],
        region: env[`${pfx}_REGION`] ?? 'us-east-1',
        bucket: env[`${pfx}_BUCKET`] ?? 'stowage-test',
        accessKey: env[`${pfx}_ACCESS_KEY`],
        secretKey: env[`${pfx}_SECRET_KEY`],
        forcePathStyle: env[`${pfx}_PATH_STYLE`] !== 'false',
        partSize: 5 * 1024 * 1024,
        createBucket: true,
      }),
    { skip: !env[`${pfx}_ENDPOINT`] },
  );
}

runConformance('ipfs (kubo)', () => new IpfsAdapter('ipfs', { apiUrl: env.KUBO_TEST_URL!, mfsRoot: '/stowage-test' }), {
  skip: !env.KUBO_TEST_URL,
});

runConformance(
  'webdav',
  () => new WebdavAdapter('dav', { url: env.WEBDAV_TEST_URL!, username: env.WEBDAV_TEST_USER, password: env.WEBDAV_TEST_PASS }),
  { skip: !env.WEBDAV_TEST_URL },
);

runConformance('rclone', () => new RcloneAdapter('rclone', { url: env.RCLONE_TEST_URL!, rcUrl: env.RCLONE_TEST_RC_URL }), {
  skip: !env.RCLONE_TEST_URL,
});

runConformance(
  'sftp',
  () =>
    new SftpAdapter('sftp', {
      host: env.SFTP_TEST_HOST!,
      port: Number(env.SFTP_TEST_PORT ?? 22),
      username: env.SFTP_TEST_USER ?? 'stowage',
      password: env.SFTP_TEST_PASS ?? 'stowage',
      root: env.SFTP_TEST_ROOT ?? '/upload',
    }),
  { skip: !env.SFTP_TEST_HOST },
);

runConformance(
  'azure (azurite)',
  () => new AzureBlobAdapter('azure', { connectionString: env.AZURE_TEST_CONNECTION_STRING!, container: 'stowage-test' }),
  { skip: !env.AZURE_TEST_CONNECTION_STRING },
);

runConformance(
  'gcs (fake-gcs-server)',
  () => new GcsAdapter('gcs', { bucket: 'stowage-test', projectId: 'test', apiEndpoint: env.GCS_TEST_ENDPOINT }),
  { skip: !env.GCS_TEST_ENDPOINT },
);
