import {
    creatorNotFound,
    handleBrainAssistant,
    handleCreatorProviders,
    handleElevenLabsSpeech,
    handleHeyGenStatus,
    handleHeyGenVideo,
    handleMuapiImage,
    handleMuapiStatus,
    handleMuapiVideo,
    handleNvidiaImage,
} from '../../../../src/lib/creatorProviderGateway.js';
import { handleCreatorProjectRoute } from '../../../../src/lib/creatorProjectRoutes.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Explicit execution budget rather than relying on the platform default.
// Comfortably covers the slowest single upstream call already made on this
// route (ElevenLabs speech, up to 120s) and NVIDIA Image Generation (up to
// ~60s), with margin for the Selena Brain Router's own bounded overall
// fallback budget (BRAIN_MAX_TOTAL_MS, see src/lib/brainRouter.js) plus
// request/response overhead.
export const maxDuration = 150;

async function dispatch(request, context, method) {
    const { path = [] } = await context.params;
    if (path[0] === 'projects') {
        return handleCreatorProjectRoute(request, {
            path: path.slice(1),
            method,
        });
    }
    const route = `${method}:${path.join('/')}`;

    switch (route) {
        case 'GET:providers':
            return handleCreatorProviders(request);
        case 'POST:assistant':
            return handleBrainAssistant(request);
        case 'POST:image':
            return handleMuapiImage(request);
        case 'POST:video':
            return handleMuapiVideo(request);
        case 'POST:nvidia-image':
            return handleNvidiaImage(request);
        case 'GET:muapi/status':
            return handleMuapiStatus(request);
        case 'POST:speech':
            return handleElevenLabsSpeech(request);
        case 'POST:heygen':
            return handleHeyGenVideo(request);
        case 'GET:heygen/status':
            return handleHeyGenStatus(request);
        default:
            return creatorNotFound();
    }
}

export function GET(request, context) {
    return dispatch(request, context, 'GET');
}

export function POST(request, context) {
    return dispatch(request, context, 'POST');
}

export function PUT(request, context) {
    return dispatch(request, context, 'PUT');
}

export function PATCH(request, context) {
    return dispatch(request, context, 'PATCH');
}

export function DELETE(request, context) {
    return dispatch(request, context, 'DELETE');
}
