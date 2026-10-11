// Session-scoped pointer to an accepted job. Store only its identity; the caller must
// recover job state through the owner-bound status route before displaying results.
export const RESUME_KEY_PREFIX = 'ogai.replicate.activeJob.v1';
export const RESUME_MAX_AGE_MS = 30 * 60 * 1000;

const JOB_ID = /^[A-Za-z0-9_-]{3,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = new Set(['v', 'jobId', 'projectId', 'userId', 'ts']);

function userIdentity(userId) {
    if (typeof userId === 'string' && userId.trim()) return userId;
    if (typeof userId === 'number' && Number.isFinite(userId)) return String(userId);
    return null;
}

function validIds(jobId, projectId) {
    return typeof jobId === 'string' && JOB_ID.test(jobId)
        && typeof projectId === 'string' && UUID.test(projectId);
}

export function createResumeStore({ storage, kind, now = Date.now } = {}) {
    const key = kind === 'image' || kind === 'video' ? `${RESUME_KEY_PREFIX}.${kind}` : null;

    function clear() {
        try {
            if (key) storage?.removeItem(key);
        } catch {
            // Session storage may be blocked or unavailable.
        }
    }

    function save(identity) {
        if (!key || !storage) return;
        try {
            const userId = userIdentity(identity?.userId);
            if (!userId || !validIds(identity?.jobId, identity?.projectId)) {
                clear();
                return;
            }
            const ts = now();
            if (!Number.isFinite(ts) || ts < 0) {
                clear();
                return;
            }
            storage.setItem(key, JSON.stringify({
                v: 1, jobId: identity.jobId, projectId: identity.projectId, userId, ts,
            }));
        } catch {
            clear();
        }
    }

    function load(identity) {
        if (!key || !storage) return null;
        try {
            const userId = userIdentity(identity?.userId);
            if (!userId) {
                clear();
                return null;
            }
            const raw = storage.getItem(key);
            if (raw === null || raw === undefined) return null;
            const value = typeof raw === 'string' ? JSON.parse(raw) : null;
            const ts = now();
            const age = ts - value?.ts;
            const valid = value && typeof value === 'object' && !Array.isArray(value)
                && Object.keys(value).length === FIELDS.size
                && Object.keys(value).every((field) => FIELDS.has(field))
                && value.v === 1 && validIds(value.jobId, value.projectId)
                && typeof value.userId === 'string' && value.userId === userId
                && Number.isFinite(value.ts) && value.ts >= 0
                && Number.isFinite(ts) && age >= 0 && age <= RESUME_MAX_AGE_MS;
            if (!valid) {
                clear();
                return null;
            }
            return { jobId: value.jobId, projectId: value.projectId };
        } catch {
            clear();
            return null;
        }
    }

    return { save, load, clear };
}

export function createBrowserResume(kind) {
    let storage = null;
    try {
        storage = typeof window !== 'undefined' ? window?.sessionStorage : null;
    } catch {
        // Access to sessionStorage itself can fail in restricted browser contexts.
    }
    return createResumeStore({ storage, kind });
}

export function clearReplicateResume() {
    createBrowserResume('image').clear();
    createBrowserResume('video').clear();
}
