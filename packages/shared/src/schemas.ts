import { z } from 'zod';

export const loginSchema = z.object({ code: z.string().min(1).max(256) });

export const moveSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });

export const mkdirSchema = z.object({ path: z.string().min(1) });

export const adapterKindSchema = z.enum(['s3', 'ipfs', 'local', 'webdav', 'sftp', 'azure', 'gcs', 'rclone']);

export const mountIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'mount id must be lowercase letters, digits and dashes');

export const mountDefSchema = z.object({
  id: mountIdSchema,
  label: z.string().min(1).optional(),
  kind: adapterKindSchema,
  readOnly: z.boolean().default(false),
  config: z.record(z.unknown()).default({}),
});

export type MountDef = z.infer<typeof mountDefSchema>;

export const mountsFileSchema = z.object({ mounts: z.array(mountDefSchema).default([]) });
