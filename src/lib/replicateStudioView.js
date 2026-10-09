import { formatUsd } from './replicateStudioForm.js';

const LOCKED = new Set(['quoting', 'submitting', 'running', 'uncertain']);
const PROGRESS = { queued: 'Queued…', processing: 'Generating…', running: 'Generating…' };

export function deriveView(state) {
    const locked = LOCKED.has(state.phase);
    const live = state.mode === 'live';
    const unacknowledged = state.phase === 'uncertain';

    const badge = state.mode === 'live'
        ? { tone: 'live', text: 'Live · paid generation' }
        : state.mode === 'mock'
            ? { tone: 'mock', text: 'Mock · no paid generation' }
            : { tone: 'setup', text: 'Setup required' };

    let disabledReason = '';
    if (!state.loaded) disabledReason = 'Loading models…';
    else if (state.loadError) disabledReason = state.loadError;
    else if (state.authLost) disabledReason = 'Sign in again to continue.';
    else if (!state.configured) disabledReason = 'Replicate is not configured on this server.';
    else if (state.mode !== 'mock' && state.mode !== 'live') disabledReason = 'Replicate mode is unknown; check server configuration.';
    else if (!state.modelId) disabledReason = 'No models are available for this workspace.';
    else if (!state.projectId) disabledReason = 'Open a Project to generate.';
    else if (unacknowledged) disabledReason = 'Acknowledge the uncertain request before generating again.';
    const ready = disabledReason === '';

    const quoted = state.phase === 'quoted' && state.quote;
    const overCapMessage = quoted && state.overCap
        ? `This estimate (${formatUsd(state.quote.estimateUsd)}) is above the per-generation limit of ${formatUsd(Number(state.quote.maxUsdPerJob))}. Choose a different model or shorter/smaller settings.`
        : '';

    let primary;
    if (state.phase === 'quoting' || state.phase === 'submitting') {
        primary = { action: 'generate', label: 'Working…', enabled: false };
    } else if (quoted && live) {
        primary = { action: 'confirm', label: `Confirm and generate · ${formatUsd(state.quote.estimateUsd)}`, enabled: ready && !state.overCap };
    } else if (live) {
        primary = { action: 'generate', label: 'Review price', enabled: ready && !locked };
    } else if (state.mode === 'mock') {
        primary = { action: 'generate', label: 'Generate (mock — no charge)', enabled: ready && !locked && !(quoted && state.overCap) };
    } else {
        primary = { action: 'generate', label: 'Generate', enabled: false };
    }

    const price = quoted
        ? { text: `${formatUsd(state.quote.estimateUsd)} · ${state.quote.display}`, expiresAt: state.quote.expiresAt }
        : null;

    const banners = [];
    if (state.authLost) banners.push({ tone: 'warn', text: 'Your session ended. Sign in again to continue; nothing was carried over.' });
    if (state.error && state.phase !== 'failed') banners.push({ tone: 'error', text: state.error });
    if (state.phase === 'failed') banners.push({ tone: 'error', text: state.error || 'Generation failed.' });
    if (state.phase === 'canceled') banners.push({ tone: 'info', text: 'Canceled. The provider confirmed the cancellation.' });
    if (state.notice) {
        const tone = state.notice.kind === 'info' ? 'info' : 'warn';
        banners.push({ tone, text: state.notice.message });
    }
    if (state.uncertain) banners.push({ tone: 'warn', text: state.uncertain.message });
    if (overCapMessage) banners.push({ tone: 'warn', text: overCapMessage });

    let result = null;
    const asset = state.job?.asset;
    if (state.phase === 'completed' && asset) {
        const mockPlaceholder = state.job.mock === true;
        result = {
            kind: asset.type === 'video' && !mockPlaceholder ? 'video' : 'image',
            url: asset.url,
            assetId: asset.id,
            mockPlaceholder,
            alt: mockPlaceholder ? `Mock placeholder for a ${state.kind}` : `Generated ${state.kind}`,
        };
    }

    return {
        locked,
        badge,
        disabledReason,
        primary,
        price,
        overCapMessage,
        showCancel: state.phase === 'running' && Boolean(state.jobId),
        showCheckStatus: (state.phase === 'running' && (state.checkFailed || state.deadlineReached))
            || (state.phase === 'uncertain' && Boolean(state.uncertain?.jobId)),
        showAcknowledge: unacknowledged,
        providerSwitchDisabled: locked,
        banners,
        progressText: state.phase === 'running' ? (PROGRESS[state.job?.status] || 'Working…') : '',
        result,
    };
}
