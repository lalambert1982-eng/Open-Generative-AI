import { authenticateCreatorRequest } from './creatorAuth.js';
import { CreatorAgentError, delegateCreatorAgent, ensureCreatorAgents } from './creatorAgentGateway.js';
import { handleBrainAssistant, creatorJson } from './creatorProviderGateway.js';

function normalized(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function delegationAction(data) {
    const actions = Array.isArray(data?.suggestedActions) ? data.suggestedActions : [];
    return actions.find((action) => action?.action === 'agent.delegate' && action?.available !== false) || null;
}

function remainingActions(data, completedActionId) {
    const actions = Array.isArray(data?.suggestedActions) ? data.suggestedActions : [];
    return actions.filter((action) => action?.id !== completedActionId);
}

function remainingSideEffects(actions) {
    return [...new Set(actions.map((action) => action?.sideEffect).filter(Boolean))];
}

function blockedAction(action, message) {
    return {
        ...action,
        available: false,
        rationale: action.rationale || message,
    };
}

function delegationFailurePayload(data, action, error) {
    const actions = Array.isArray(data?.suggestedActions)
        ? data.suggestedActions.map((candidate) => candidate?.id === action?.id
            ? blockedAction(candidate, error.message)
            : candidate)
        : [];
    return {
        ...data,
        message: `${data.message || data.text || 'I prepared the next Creator Studio steps.'}\n\nCreator Agent delegation is not ready yet: ${error.message}`,
        text: `${data.message || data.text || 'I prepared the next Creator Studio steps.'}\n\nCreator Agent delegation is not ready yet: ${error.message}`,
        suggestedActions: actions,
        structuredOutput: {
            ...(data.structuredOutput || {}),
            message: `${data.message || data.text || 'I prepared the next Creator Studio steps.'}\n\nCreator Agent delegation is not ready yet: ${error.message}`,
            suggestedActions: actions,
        },
        agentDelegation: {
            status: 'blocked',
            agentId: action?.parameters?.agentId || null,
            code: error.code || 'agent_unavailable',
            error: error.message,
        },
    };
}

export async function handleSelenaAgentAssistant(request, {
    env = process.env,
    fetchImpl = fetch,
    blobStore,
    auditBlobStore,
    projectLoader,
    pollOptions,
} = {}) {
    const inputRequest = request.clone();
    const baseResponse = await handleBrainAssistant(request, {
        env,
        fetchImpl,
        blobStore,
        ...(projectLoader ? { projectLoader } : {}),
    });
    if (!baseResponse.ok) return baseResponse;

    let data;
    try {
        data = await baseResponse.clone().json();
    } catch {
        return baseResponse;
    }
    const action = delegationAction(data);
    if (!action) return baseResponse;

    let input;
    try {
        input = await inputRequest.json();
    } catch {
        return baseResponse;
    }
    const projectId = normalized(input?.projectId);
    if (!projectId) {
        const error = new CreatorAgentError(
            'project_required',
            'Open or create a Project before Selena delegates work to a specialized Creator Agent.',
            409,
        );
        return creatorJson(delegationFailurePayload(data, action, error));
    }

    const authentication = authenticateCreatorRequest(inputRequest, { env });
    if (!authentication.valid) return baseResponse;

    const delegationInput = {
        agentId: action.parameters?.agentId,
        task: action.parameters?.task || input.prompt || input.task,
        projectId,
        assetId: action.parameters?.assetId || input.selectedAssetId || undefined,
    };

    let result;
    try {
        result = await delegateCreatorAgent(authentication.user, delegationInput, {
            env,
            fetchImpl,
            blobStore,
            auditBlobStore,
            pollOptions,
        });
    } catch (error) {
        const canProvision = error?.code === 'agent_not_provisioned' &&
            String(env.CREATOR_AGENT_AUTO_PROVISION || '').trim().toLowerCase() === 'true';
        if (canProvision) {
            try {
                await ensureCreatorAgents({ env, fetchImpl });
                result = await delegateCreatorAgent(authentication.user, delegationInput, {
                    env,
                    fetchImpl,
                    blobStore,
                    auditBlobStore,
                    pollOptions,
                });
            } catch (retryError) {
                return creatorJson(delegationFailurePayload(data, action, retryError));
            }
        } else {
            return creatorJson(delegationFailurePayload(data, action, error));
        }
    }

    const actions = remainingActions(data, action.id);
    const sideEffects = remainingSideEffects(actions);
    const message = [
        data.message || data.text || 'I delegated this to the appropriate Creator Agent.',
        `${result.agentName}: ${result.message}`,
    ].filter(Boolean).join('\n\n');
    const structuredOutput = {
        ...(data.structuredOutput || {}),
        message,
        suggestedActions: actions,
    };
    return creatorJson({
        ...data,
        message,
        text: message,
        suggestedActions: actions,
        structuredOutput,
        requiresApproval: actions.some((candidate) => candidate?.requiresApproval === true),
        estimatedSideEffects: sideEffects,
        agentResult: result,
        agentDelegation: {
            status: 'completed',
            agentId: result.agentId,
            agentName: result.agentName,
            conversationId: result.conversationId,
        },
    });
}
