const MUAPI_BASE = 'https://api.muapi.ai';

export function buildMuapiUrl(prefix, pathSegments = [], search = '') {
    const safePrefix = String(prefix || '')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');

    const safePath = pathSegments.map((segment) => {
        const value = String(segment);
        if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
            throw new Error('Invalid proxy path');
        }
        return encodeURIComponent(value);
    }).join('/');

    const pathname = safePath ? `${safePrefix}/${safePath}` : safePrefix;
    return `${MUAPI_BASE}/${pathname}${search}`;
}
