// Server-side MuAPI Agent Blueprint calls used by creatorAgentGateway.js.
// Functions moved verbatim from packages/studio/src/muapi.js. The gateway
// supplies the server-owned API key; this module never runs in the browser.
const BASE_URL = 'https://api.muapi.ai';

export async function getUserAgents(apiKey) {
    const response = await fetch(`${BASE_URL}/agents/user/agents`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch user agents: ${response.status} - ${errText.slice(0, 100)}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : (data.agents || data.items || []);
};

export async function getAgentConversation(apiKey, agentSlug, conversationId) {
    const response = await fetch(`${BASE_URL}/agents/by-slug/${agentSlug}/${conversationId}`, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        }
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to fetch conversation: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

export async function sendAgentChatMessage(apiKey, agentSlug, { message, conversationId, attachments } = {}) {
    const response = await fetch(`${BASE_URL}/agents/by-slug/${agentSlug}/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify({
            message,
            conversation_id: conversationId || null,
            attachments: attachments || null,
            stream: false
        })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to send message: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}

export async function pollAgentChatResult(apiKey, requestId, { maxAttempts = 150, interval = 2000 } = {}) {
    const url = `${BASE_URL}/api/v1/predictions/${requestId}/result`;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, interval));
        const response = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey
            }
        });
        if (response.status === 400) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(errBody?.detail?.error || 'Agent failed to respond');
        }
        if (!response.ok) {
            if (attempt === maxAttempts) throw new Error(`Poll failed: ${response.status}`);
            continue;
        }
        const data = await response.json();
        if (data.is_complete) return data;
    }
    throw new Error('Agent response timed out.');
}

export async function createAgent(apiKey, payload) {
    const response = await fetch(`${BASE_URL}/agents`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to create agent: ${response.status} - ${errText.slice(0, 100)}`);
    }
    return await response.json();
}
