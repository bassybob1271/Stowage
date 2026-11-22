export type AdapterKind =
  | 's3'
  | 'ipfs'
  | 'local'
  | 'webdav'
  | 'sftp'
  | 'azure'
  | 'gcs'
  | 'rclone';

export interface Capabilities {
  list: boolean;
  rename: boolean;
  delete: boolean;
  rangeRead: boolean;
  multipartUpload: boolean;
  presignedUrls: boolean;
  contentAddressed: boolean;
  versioning: boolean;
}

export type CapabilityName = keyof Capabilities;

export interface FileStat {
  /** Mount-relative POSIX path, no leading slash. '' is the mount root. */
  path: string;
  name: string;
  size: number;
  mime: string;
  etag?: string;
  cid?: string;
  /** ISO-8601 */
  modifiedAt: string;
  isDir: boolean;
}

export interface ListResult {
  entries: FileStat[];
  cursor?: string;
}

export interface MountInfo {
  id: string;
  label: string;
  kind: AdapterKind;
  readOnly: boolean;
  capabilities: Capabilities;
  /** Capabilities provided by the emulation wrapper rather than natively. */
  emulated: CapabilityName[];
  health: { ok: boolean; detail?: string };
  source: 'yaml' | 'db';
}
