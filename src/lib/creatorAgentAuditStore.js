import { createHmac } from 'node:crypto';

import { get as getBlob, put as putBlob } from '@vercel/blob';

const AUDIT_ROOT = 'creator-project-agents';
const MAX_RECORDS = 24;
const MAX_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,139}$/;

const defaultBlobStore = { get: getBlob, put: putBlob };

function normalized(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function configuration(env) {
    const blobToken = normalized(env.BLOB_READ_WRITE_TOKEN);
    const sessionSecret = normalized(env.CREATOR_SESSION_SECRET);
    if (blobToken.length < 20 || sessionSecret.length < 32) {
        throw new Error('Creator Agent audit storage is not configured.');
    }
    return { blobToken, sessionSecret };
}

function ownerSubject(user, config) {
    const subject = String(user?.id || '').trim();
    if (!/^\d+$/.test(subject)) throw new Error('Creator owner identity is invalid.');
    return createHmac('sha256', config.sessionSecret)
        .update(`creator-project-owner:${subject}`, 'utf8')
        .digest('hex')
        .slice(0, 40);
}

function projectId(value) {
    const id = normalized(value).toLowerCase();
    if (!UUID_PATTERN.test(id)) throw new Error('A valid Project ID is required.');
    return id;
}

function auditPath(owner, id) {
    return `${AUDIT_ROOT}/${owner}/${id}.json`;
}

function text(value, maximum) {
    return normalized(value).slice(0, maximum);
}

function normalizeRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const agentId = text(value.agentId, 60);
    const conversationId = text(value.conversationId, 140);
    if (!agentId || (conversationId && !OPAQUE_ID_PATTERN.test(conversationId))) return null;
    return {
        agentId,
        agentName: text(value.agentName, 120),
        conversationId: conversationId || null,
        taskSummary: text(value.taskSummary, 1000),
        resultSummary: text(value.resultSummary, 4000),
        status: text(value.status, 40) || 'unknown',
        createdAt: text(value.createdAt, 40) || new Date().toISOString(),
    };
}

async function blobText(result) {
    if (!result) return '';
    if (typeof result.text === 'function') return result.text();
    if (result.stream) return new Response(result.stream).text();
    if (result.body) return new Response(result.body).text();
    return '';
}

async function readRecords(pathname, config, blobStore) {
    try {
        const result = await blobStore.get(pathname, {
            token: config.blobToken,
            access: 'private',
            useCache: false,
        });
        if (!result) return [];
        const raw = await blobText(result);
        if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return [];
        const decoded = JSON.parse(raw);
        return Array.isArray(decoded?.records)
            ? decoded.records.map(normalizeRecord).filter(Boolean).slice(0, MAX_RECORDS)
            : [];
    } catch {
        return [];
    }
}

export async function listCreatorAgentAudit(user, projectIdValue, {
    env = process.env,
    blobStore = defaultBlobStore,
} = {}) {
    const config = configuration(env);
    const owner = ownerSubject(user, config);
    const id = projectId(projectIdValue);
    return readRecords(auditPath(owner, id), config, blobStore);
}

export async function appendCreatorAgentAudit(user, projectIdValue, record, {
    env = process.env,
    blobStore = defaultBlobStore,
} = {}) {
    const config = configuration(env);
    const owner = ownerSubject(user, config);
    const id = projectId(projectIdValue);
    const pathname = auditPath(owner, id);
    const normalizedRecord = normalizeRecord(record);
    if (!normalizedRecord) throw new Error('Creator Agent audit record is invalid.');
    const records = await readRecords(pathname, config, blobStore);
    const next = [normalizedRecord, ...records].slice(0, MAX_RECORDS);
    const body = JSON.stringify({ version: 1, projectId: id, records: next });
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw new Error('Creator Agent audit record is too large.');
    await blobStore.put(pathname, body, {
        token: config.blobToken,
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        contentType: 'application/json',
    });
    return normalizedRecord;
}

export function creatorAgentAuditStoreForTests(records = new Map()) {
    return {
        records,
        async put(pathname, body) {
            records.set(pathname, { pathname, body: String(body) });
            return { pathname, url: `https://private.test/${pathname}` };
        },
        async get(pathname) {
            const record = records.get(pathname);
            if (!record) return null;
            return { text: async () => record.body };
        },
    };
}
