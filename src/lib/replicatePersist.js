import { isIP } from 'node:net';

import {
    addCreatorAsset,
    creatorAssetStorageConfiguration,
    creatorAssetUploadPrefix,
    defaultBlobStore,
    getCreatorProject,
} from './creatorProjectStore.js';

const MAX_MEDIA_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const EXTENSIONS = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
});
// 1x1 PNG used as the stored output of mock generations.
const MOCK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

export class PersistError extends Error {
    constructor(code, message, status = 502) {
        super(message);
        this.name = 'PersistError';
        this.code = code;
        this.status = status;
    }
}

export function isReplicateDeliveryUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) return false;
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        return url.protocol === 'https:'
            && !url.username
            && !url.password
            && isIP(host) === 0
            && (host === 'replicate.delivery' || host.endsWith('.replicate.delivery'));
    } catch {
        return false;
    }
}

async function downloadOutput(outputUrl, kind, fetchImpl) {
    if (!isReplicateDeliveryUrl(outputUrl)) {
        throw new PersistError('output_not_allowed', 'The generated output is not on an allowed host.');
    }
    let response;
    try {
        response = await fetchImpl(outputUrl, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch {
        throw new PersistError('download_failed', 'Could not download the generated output.');
    }
    if (!response.ok) throw new PersistError('download_failed', 'The generated output is no longer available.');
    const tooLarge = new PersistError('output_too_large', 'The generated output is too large.', 413);
    if (Number(response.headers?.get?.('content-length') || 0) > MAX_MEDIA_BYTES) throw tooLarge;
    const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!EXTENSIONS[contentType] || !contentType.startsWith(`${kind}/`)) {
        throw new PersistError('unexpected_media_type', 'The generated output has an unexpected media type.');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) throw tooLarge;
    return { bytes, contentType };
}

export async function persistGeneratedAsset({
    user,
    projectId,
    record,
    outputUrl,
    env = process.env,
    fetchImpl = fetch,
    assetBlobStore = defaultBlobStore,
    blobStore = defaultBlobStore,
    now = Date.now(),
    idGenerator,
}) {
    const assetConfiguration = creatorAssetStorageConfiguration(env);
    if (!assetConfiguration.configured) {
        throw new PersistError('asset_storage_unconfigured', 'Asset storage is not configured.', 503);
    }
    // Ownership check first: throws a 404 CreatorProjectError for foreign or missing Projects.
    await getCreatorProject(user, projectId, { env, blobStore });

    const media = record.mock
        ? { bytes: MOCK_PNG, contentType: 'image/png' }
        : await downloadOutput(outputUrl, record.kind, fetchImpl);
    const storagePath = `${creatorAssetUploadPrefix(projectId)}replicate-${record.jobId}.${EXTENSIONS[media.contentType]}`;
    let uploaded;
    try {
        uploaded = await assetBlobStore.put(storagePath, media.bytes, {
            token: assetConfiguration.blobToken,
            access: 'public',
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: media.contentType,
        });
    } catch {
        throw new PersistError('upload_failed', 'The generated output could not be stored.');
    }
    return addCreatorAsset(user, projectId, {
        type: record.mock ? 'graphic' : record.kind,
        title: String(record.prompt || 'Generated asset').slice(0, 160),
        url: uploaded.url,
        storagePath,
        source: 'replicate',
        mimeType: media.contentType,
        size: media.bytes.length,
        provider: { provider: 'replicate', model: record.model, jobId: record.jobId },
    }, { env, blobStore, now, ...(idGenerator ? { idGenerator } : {}) });
}
