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

async function readBounded(response, deadline, tooLarge) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = Buffer.from(await Promise.race([response.arrayBuffer(), deadline.promise]));
        if (bytes.length > MAX_MEDIA_BYTES) throw tooLarge;
        return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await Promise.race([reader.read(), deadline.promise]);
            if (done) break;
            total += value.length;
            if (total > MAX_MEDIA_BYTES) {
                await reader.cancel().catch(() => {});
                throw tooLarge;
            }
            chunks.push(value);
        }
    } catch (error) {
        if (error === tooLarge) throw error;
        await reader.cancel().catch(() => {});
        throw new PersistError('download_failed', 'Could not download the generated output.');
    }
    return Buffer.concat(chunks, total);
}

async function downloadOutput(outputUrl, kind, fetchImpl) {
    if (!isReplicateDeliveryUrl(outputUrl)) {
        throw new PersistError('output_not_allowed', 'The generated output is not on an allowed host.');
    }
    const controller = new AbortController();
    let timer;
    const deadline = {
        promise: new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error('download_timeout'));
            }, DOWNLOAD_TIMEOUT_MS);
        }),
    };
    deadline.promise.catch(() => {});
    try {
        let response;
        try {
            response = await Promise.race([fetchImpl(outputUrl, { redirect: 'error', signal: controller.signal }), deadline.promise]);
        } catch {
            throw new PersistError('download_failed', 'Could not download the generated output.');
        }
        if (!response.ok) throw new PersistError('download_failed', 'The generated output is no longer available.');
        const tooLarge = new PersistError('output_too_large', 'The generated output is too large.', 413);
        if (Number(response.headers?.get?.('content-length') || 0) > MAX_MEDIA_BYTES) {
            await response.body?.cancel?.().catch(() => {});
            throw tooLarge;
        }
        const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!EXTENSIONS[contentType] || !contentType.startsWith(`${kind}/`)) {
            await response.body?.cancel?.().catch(() => {});
            throw new PersistError('unexpected_media_type', 'The generated output has an unexpected media type.');
        }
        return { bytes: await readBounded(response, deadline, tooLarge), contentType };
    } finally {
        clearTimeout(timer);
    }
}

function validateRecord(record) {
    const jobId = record?.jobId;
    const valid = typeof jobId === 'string'
        && /^[A-Za-z0-9_-]{3,60}$/.test(jobId)
        && (record.kind === 'image' || record.kind === 'video')
        && typeof record.mock === 'boolean'
        && record.mock === jobId.startsWith('mock_');
    if (!valid) throw new PersistError('invalid_record', 'The generation record is invalid.', 400);
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
    validateRecord(record);
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
    try {
        return await addCreatorAsset(user, projectId, {
            type: record.mock ? 'graphic' : record.kind,
            title: String(record.prompt || 'Generated asset').slice(0, 160),
            url: uploaded.url,
            storagePath,
            source: 'replicate',
            mimeType: media.contentType,
            size: media.bytes.length,
            provider: { provider: 'replicate', model: record.model, jobId: record.jobId },
        }, { env, blobStore, now, ...(idGenerator ? { idGenerator } : {}) });
    } catch (error) {
        // Nothing references the blob yet; remove it and surface the original failure.
        await Promise.resolve(assetBlobStore.del?.(storagePath, { token: assetConfiguration.blobToken })).catch(() => {});
        throw error;
    }
}
