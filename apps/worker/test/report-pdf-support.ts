import type { BlobStore } from '@olcys/core';
import { createReportManifest } from '@olcys/reporting';
import { createHash } from 'node:crypto';
import type { ReportData } from '../../../packages/reporting/src/types.ts';

export const createManifestForTest = (data: ReportData, html: string, blobs: BlobStore) =>
  createReportManifest(data, createHash('sha256').update(html).digest('hex'), blobs);
