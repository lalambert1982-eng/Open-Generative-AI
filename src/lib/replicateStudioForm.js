// Pure helpers for the Replicate settings form. No browser or server APIs.

export function formatUsd(value) {
    const cents = value.toFixed(2);
    if (Math.abs(Number(cents) - value) < 1e-9) return `$${cents}`;
    return `$${Number(value.toFixed(4))}`;
}

export function fieldLabel(name) {
    const text = String(name).replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export function defaultValues(model) {
    const values = {};
    for (const [name, spec] of Object.entries(model?.inputs || {})) {
        if (spec.default !== undefined) values[name] = spec.default;
    }
    return values;
}

export function pickDefaultModel(models, kind) {
    return (models || []).find((item) => item.kind === kind && item.enabled !== false) || null;
}

export function assetChoices(assets) {
    return (assets || [])
        .filter((asset) => ['image', 'graphic'].includes(asset?.type) && typeof asset.url === 'string' && asset.url)
        .map((asset) => ({ id: asset.id, url: asset.url, title: asset.title || asset.id }));
}

function blank(value) {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

export function buildInput(model, values) {
    const input = {};
    for (const [name, spec] of Object.entries(model?.inputs || {})) {
        const value = values?.[name];
        switch (spec.type) {
            case 'string': {
                if (!blank(value)) input[name] = String(value).trim();
                break;
            }
            case 'url': {
                if (!blank(value)) input[name] = String(value);
                break;
            }
            case 'urlArray': {
                const list = (Array.isArray(value) ? value : []).filter((item) => !blank(item));
                if (list.length) input[name] = list;
                break;
            }
            case 'enum': {
                const match = (spec.values || []).find((candidate) => String(candidate) === String(value));
                if (match !== undefined) input[name] = match;
                break;
            }
            case 'integer': {
                if (!blank(value) && Number.isFinite(Number(value))) input[name] = Number(value);
                break;
            }
            case 'boolean': {
                if (value !== undefined) input[name] = Boolean(value);
                break;
            }
            default:
        }
    }
    return input;
}

export function validationErrors(model, values) {
    const errors = {};
    for (const [name, spec] of Object.entries(model?.inputs || {})) {
        const value = values?.[name];
        if (spec.type === 'string') {
            if (spec.required && blank(value)) errors[name] = 'Required.';
            else if (!blank(value) && String(value).trim().length > spec.max) errors[name] = `Use ${spec.max} characters or fewer.`;
        } else if (spec.type === 'url') {
            if (spec.required && blank(value)) errors[name] = 'Select an Asset from this Project.';
        } else if (spec.type === 'urlArray') {
            const list = (Array.isArray(value) ? value : []).filter((item) => !blank(item));
            if (spec.max && list.length > spec.max) errors[name] = `Select at most ${spec.max}.`;
        } else if (spec.type === 'integer' && !blank(value)) {
            const number = Number(value);
            if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
                errors[name] = `Enter a whole number from ${spec.min} to ${spec.max}.`;
            }
        }
    }
    return errors;
}
