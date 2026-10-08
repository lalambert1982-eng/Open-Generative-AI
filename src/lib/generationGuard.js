import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const ROOT = 'creator-generation';
const LOCK_TTL_MS = 60 * 1000;
const QUOTE_TTL_MS = 5 * 60 * 1000;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{3,60}$/;

export class GenerationGuardError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'GenerationGuardError';
        this.code = code;
        this.status = status;
    }
}

function normalized(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function sessionSecret(env) {
    const secret = normalized(env.CREATOR_SESSION_SECRET);
    if (secret.length < 32) {
        throw new GenerationGuardError('unconfigured', 'Generation controls are not configured.', 503);
    }
    return secret;
}

export function generationOwnerKey(user, env = process.env) {
    const subject = String(user?.id ?? '').trim();
    if (!/^\d+$/.test(subject)) throw new GenerationGuardError('invalid_owner', 'Creator owner identity is invalid.', 403);
    return createHmac('sha256', sessionSecret(env)).update(`generation-owner:${subject}`, 'utf8').digest('hex').slice(0, 40);
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

export function requestFingerprint(ownerKey, modelId, input) {
    return createHash('sha256').update(JSON.stringify([ownerKey, modelId, canonical(input)])).digest('hex');
}

function quoteSignature(env, payload) {
    return createHmac('sha256', sessionSecret(env)).update(`generation-quote:${payload}`, 'utf8').digest('base64url');
}

function quotePayload({ user, env, modelId, input, estimateUsd }, expiresAt) {
    const fingerprint = requestFingerprint(generationOwnerKey(user, env), modelId, input);
    return `${fingerprint}.${Number(estimateUsd).toFixed(4)}.${expiresAt}`;
}

export function issueQuote({ user, env, modelId, input, estimateUsd, now = Date.now() }) {
    const expiresAt = now + QUOTE_TTL_MS;
    const signature = quoteSignature(env, quotePayload({ user, env, modelId, input, estimateUsd }, expiresAt));
    return { token: `${expiresAt}.${signature}`, estimateUsd, expiresAt };
}

export function verifyQuote(token, { user, env, modelId, input, estimateUsd, now = Date.now() }) {
    if (typeof token !== 'string') return false;
    const separator = token.indexOf('.');
    if (separator < 1) return false;
    const expiresAtText = token.slice(0, separator);
    const given = token.slice(separator + 1);
    if (!/^\d{10,16}$/.test(expiresAtText)) return false;
    const expiresAt = Number(expiresAtText);
    if (expiresAt < now) return false;
    const expected = quoteSignature(env, quotePayload({ user, env, modelId, input, estimateUsd }, expiresAt));
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function storeAccess(env, blobStore) {
    const token = normalized(env.BLOB_READ_WRITE_TOKEN);
    if (token.length < 20) throw new GenerationGuardError('unconfigured', 'Generation storage is not configured.', 503);
    return {
        async read(pathname) {
            let result;
            try {
                result = await blobStore.get(pathname, { token, access: 'private', useCache: false });
            } catch {
                throw new GenerationGuardError('storage_unavailable', 'Generation storage is temporarily unavailable.', 503);
            }
            if (!result) return null;
            let text = '';
            if (typeof result.text === 'function') text = await result.text();
            else if (result.stream) text = await new Response(result.stream).text();
            else if (result.body) text = await new Response(result.body).text();
            try {
                return JSON.parse(text);
            } catch {
                return null;
            }
        },
        async write(pathname, value, { overwrite = true } = {}) {
            try {
                await blobStore.put(pathname, JSON.stringify(value), {
                    token,
                    access: 'private',
                    addRandomSuffix: false,
                    allowOverwrite: overwrite,
                    contentType: 'application/json',
                });
            } catch (error) {
                if (!overwrite) throw error;
                throw new GenerationGuardError('storage_unavailable', 'Generation storage is temporarily unavailable.', 503);
            }
        },
    };
}

function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}

export async function reserveGeneration({
    user,
    env,
    blobStore,
    mode,
    modelId,
    input,
    estimateUsd,
    quoteToken,
    limits,
    now = Date.now(),
}) {
    const ownerKey = generationOwnerKey(user, env);
    if (estimateUsd > limits.maxUsdPerJob) {
        throw new GenerationGuardError('job_limit', 'Estimated cost exceeds the per-generation limit.', 402);
    }
    if (mode === 'live' && !verifyQuote(quoteToken, { user, env, modelId, input, estimateUsd, now })) {
        throw new GenerationGuardError('confirmation_required', 'Review the estimated cost and confirm before generating.', 428);
    }
    const store = storeAccess(env, blobStore);

    let ledgerDay = null;
    let ledger = null;
    let ledgerPath = null;
    if (mode === 'live') {
        ledgerDay = new Date(now).toISOString().slice(0, 10);
        ledgerPath = `${ROOT}/${ownerKey}/ledger/${ledgerDay}.json`;
        ledger = (await store.read(ledgerPath)) || { day: ledgerDay, spentUsd: 0, jobs: 0 };
        if (round4(ledger.spentUsd + estimateUsd) > limits.maxUsdPerDay) {
            throw new GenerationGuardError('daily_limit', 'Daily generation spend limit reached.', 402);
        }
    }

    const fingerprint = requestFingerprint(ownerKey, modelId, input);
    const lockPath = `${ROOT}/${ownerKey}/locks/${fingerprint}.json`;
    const existing = await store.read(lockPath);
    if (existing && existing.expiresAt > now) {
        throw new GenerationGuardError('duplicate_submission', 'An identical generation was just submitted. Please wait.', 409);
    }
    try {
        await store.write(lockPath, { expiresAt: now + LOCK_TTL_MS }, { overwrite: Boolean(existing) });
    } catch {
        throw new GenerationGuardError('duplicate_submission', 'An identical generation was just submitted. Please wait.', 409);
    }

    if (ledger) {
        ledger.spentUsd = round4(ledger.spentUsd + estimateUsd);
        ledger.jobs += 1;
        await store.write(ledgerPath, ledger);
    }
    return { ownerKey, fingerprint, lockPath, ledgerDay, estimateUsd };
}

export async function refundSpend({ user, env, blobStore, ledgerDay, estimateUsd }) {
    if (!ledgerDay) return;
    const store = storeAccess(env, blobStore);
    const path = `${ROOT}/${generationOwnerKey(user, env)}/ledger/${ledgerDay}.json`;
    const ledger = await store.read(path);
    if (!ledger) return;
    ledger.spentUsd = Math.max(0, round4(ledger.spentUsd - estimateUsd));
    await store.write(path, ledger);
}

export async function releaseGeneration({ user, env, blobStore, reservation, now = Date.now() }) {
    const store = storeAccess(env, blobStore);
    await store.write(reservation.lockPath, { expiresAt: now - 1 });
    await refundSpend({ user, env, blobStore, ledgerDay: reservation.ledgerDay, estimateUsd: reservation.estimateUsd });
}

function jobPath(user, jobId, env) {
    return `${ROOT}/${generationOwnerKey(user, env)}/jobs/${jobId}.json`;
}

export async function saveJobRecord(user, record, { env, blobStore }) {
    if (!JOB_ID_PATTERN.test(String(record?.jobId ?? ''))) {
        throw new GenerationGuardError('invalid_job', 'A valid job ID is required.', 400);
    }
    await storeAccess(env, blobStore).write(jobPath(user, record.jobId, env), record);
}

export async function loadJobRecord(user, jobId, { env, blobStore }) {
    if (!JOB_ID_PATTERN.test(String(jobId ?? ''))) return null;
    return storeAccess(env, blobStore).read(jobPath(user, jobId, env));
}
