import type { MountDef } from '@stowage/shared';
import type { StorageAdapter } from './types.js';
import { withEmulation, type EmulatedAdapter } from './emulation.js';
import { LocalAdapter, type LocalConfig } from './adapters/local.js';
import { S3Adapter, type S3Config } from './adapters/s3.js';
import { IpfsAdapter, type IpfsConfig } from './adapters/ipfs.js';
import { WebdavAdapter, type WebdavConfig } from './adapters/webdav.js';
import { RcloneAdapter, type RcloneConfig } from './adapters/rclone.js';
import { SftpAdapter, type SftpConfig } from './adapters/sftp.js';
import { AzureBlobAdapter, type AzureConfig } from './adapters/azure.js';
import { GcsAdapter, type GcsConfig } from './adapters/gcs.js';

export * from './types.js';
export * from './streams.js';
export { withEmulation, type EmulatedAdapter } from './emulation.js';
export {
  LocalAdapter,
  S3Adapter,
  IpfsAdapter,
  WebdavAdapter,
  RcloneAdapter,
  SftpAdapter,
  AzureBlobAdapter,
  GcsAdapter,
};
export { PinningServiceClient } from './adapters/ipfs.js';
export type { LocalConfig, S3Config, IpfsConfig, WebdavConfig, RcloneConfig, SftpConfig, AzureConfig, GcsConfig };

/** Build a raw adapter from a mount definition. */
export function createAdapter(def: Pick<MountDef, 'id' | 'kind' | 'config'>): StorageAdapter {
  const c = def.config as never;
  switch (def.kind) {
    case 'local':
      return new LocalAdapter(def.id, c as LocalConfig);
    case 's3':
      return new S3Adapter(def.id, c as S3Config);
    case 'ipfs':
      return new IpfsAdapter(def.id, c as IpfsConfig);
    case 'webdav':
      return new WebdavAdapter(def.id, c as WebdavConfig);
    case 'rclone':
      return new RcloneAdapter(def.id, c as RcloneConfig);
    case 'sftp':
      return new SftpAdapter(def.id, c as SftpConfig);
    case 'azure':
      return new AzureBlobAdapter(def.id, c as AzureConfig);
    case 'gcs':
      return new GcsAdapter(def.id, c as GcsConfig);
    default:
      throw new Error(`unknown adapter kind: ${String((def as { kind: unknown }).kind)}`);
  }
}

/** Build an adapter wrapped with path normalization, emulation and read-only enforcement. */
export function createMount(def: Pick<MountDef, 'id' | 'kind' | 'config' | 'readOnly'>): EmulatedAdapter {
  return withEmulation(createAdapter(def), { readOnly: def.readOnly });
}
