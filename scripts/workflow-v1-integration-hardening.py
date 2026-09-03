from pathlib import Path


def read(path):
    return Path(path).read_text(encoding="utf-8")


def write(path, text):
    Path(path).write_text(text, encoding="utf-8")


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f"{label}: start marker not found")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f"{label}: end marker not found")
    return text[:start_index] + replacement + text[end_index:]


# ---------------------------------------------------------------------------
# Creator Workflow gateway: server-owned read boundary + paid execution gate.
# ---------------------------------------------------------------------------
path = "src/lib/creatorWorkflowGateway.js"
text = read(path)
old = """function providerConfiguration(env) {
    const configuration = muapiConfiguration(env);
    if (!configuration.configured) {
        throw new CreatorWorkflowError(
            'workflow_provider_unconfigured',
            'MuAPI Workflow execution is not configured for this environment.',
            503,
        );
    }
    return configuration;
}
"""
new = """function providerReadConfiguration(env) {
    const configuration = muapiConfiguration(env);
    const missing = Array.isArray(configuration.missing)
        ? configuration.missing.filter((item) => item !== 'MUAPI_ALLOW_PAID_GENERATION=true')
        : [];
    if (missing.length > 0) {
        throw new CreatorWorkflowError(
            'workflow_provider_unconfigured',
            'MuAPI Workflow access is not configured for this environment.',
            503,
        );
    }
    return configuration;
}

function providerExecutionConfiguration(env) {
    const configuration = muapiConfiguration(env);
    if (!configuration.configured) {
        throw new CreatorWorkflowError(
            'workflow_provider_unconfigured',
            'MuAPI Workflow execution is not configured or paid generation is not enabled for this environment.',
            503,
        );
    }
    return configuration;
}
"""
text = replace_once(text, old, new, "workflow provider configuration")

# First configuration lookup is submitRun; second is refreshRun.
needle = "    const configuration = providerConfiguration(options.env);"
if text.count(needle) != 2:
    raise SystemExit(f"workflow provider call sites: expected two matches, found {text.count(needle)}")
text = text.replace(needle, "    const configuration = providerExecutionConfiguration(options.env);", 1)
text = text.replace(needle, "    const configuration = providerReadConfiguration(options.env);", 1)

insert_marker = "function providerRunId(value) {"
helpers = r"""
function workflowIdFromPath(value) {
    const id = normalized(value);
    if (!OPAQUE_ID_PATTERN.test(id)) {
        throw new CreatorWorkflowError('invalid_workflow', 'A valid Workflow ID is required.');
    }
    return id;
}

function workflowCatalogSource(value) {
    if (Array.isArray(value)) return value;
    for (const key of ['workflows', 'items', 'data', 'results']) {
        if (Array.isArray(value?.[key])) return value[key];
    }
    return [];
}

function publicWorkflowCatalog(value) {
    return workflowCatalogSource(value).slice(0, 100).map((item, index) => {
        const id = normalized(item?.id || item?.workflow_id || item?.workflowId || item?._id);
        if (!OPAQUE_ID_PATTERN.test(id)) return null;
        return {
            id,
            workflow_id: id,
            name: safeProviderText(item?.name || item?.title || `Workflow ${index + 1}`).slice(0, 160) || `Workflow ${index + 1}`,
            category: safeProviderText(item?.category || item?.type || 'General').slice(0, 80) || 'General',
            user_name: safeProviderText(item?.user_name || item?.userName || '').slice(0, 100) || null,
        };
    }).filter(Boolean);
}

function publicSchemaScalar(value, maximum = 4000) {
    if (typeof value === 'string') return safeProviderText(value).slice(0, maximum);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
}

function publicWorkflowInputSchema(value) {
    const source = value?.input_data && typeof value.input_data === 'object' && !Array.isArray(value.input_data)
        ? value.input_data
        : value;
    const sourceProperties = source?.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)
        ? source.properties
        : {};
    const properties = {};
    for (const [key, raw] of Object.entries(sourceProperties).slice(0, 100)) {
        if (!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(key)) continue;
        if (/^(?:api[-_]?key|x[-_]?api[-_]?key|authorization|credential|credentials|password|secret|token)$/i.test(key)) continue;
        const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const type = ['string', 'number', 'integer', 'boolean'].includes(normalized(item.type).toLowerCase())
            ? normalized(item.type).toLowerCase()
            : 'string';
        const property = { type };
        const title = publicSchemaScalar(item.title, 160);
        const description = publicSchemaScalar(item.description, 1000);
        if (title) property.title = title;
        if (description) property.description = description;
        const defaultValue = publicSchemaScalar(item.default);
        if (defaultValue !== undefined) property.default = defaultValue;
        if (Array.isArray(item.enum)) {
            const values = item.enum.map((entry) => publicSchemaScalar(entry, 500)).filter((entry) => entry !== undefined).slice(0, 50);
            if (values.length > 0) property.enum = values;
        }
        if (Array.isArray(item.examples)) {
            const examples = item.examples.map((entry) => publicSchemaScalar(entry, 1000)).filter((entry) => entry !== undefined).slice(0, 10);
            if (examples.length > 0) property.examples = examples;
        } else {
            const example = publicSchemaScalar(item.examples, 1000);
            if (example !== undefined) property.examples = example;
        }
        properties[key] = property;
    }
    return {
        input_data: {
            type: 'object',
            properties,
        },
    };
}

async function creatorWorkflowCatalog(kind, options) {
    const endpoints = {
        templates: 'get-template-workflows',
        mine: 'get-workflow-defs',
        published: 'get-published-workflows',
    };
    const endpoint = endpoints[kind];
    if (!endpoint) throw new CreatorWorkflowError('invalid_workflow_catalog', 'Workflow catalog is invalid.');
    const configuration = providerReadConfiguration(options.env);
    const value = await providerJson(
        options.fetchImpl,
        buildMuapiUrl('workflow', [endpoint]),
        { method: 'GET' },
        configuration,
        30_000,
    );
    return publicWorkflowCatalog(value);
}

async function creatorWorkflowInputs(workflowId, options) {
    const id = workflowIdFromPath(workflowId);
    const configuration = providerReadConfiguration(options.env);
    const value = await providerJson(
        options.fetchImpl,
        buildMuapiUrl('workflow', [id, 'api-inputs']),
        { method: 'GET' },
        configuration,
        30_000,
    );
    return publicWorkflowInputSchema(value);
}

"""
if insert_marker not in text:
    raise SystemExit("workflow helper insertion marker not found")
text = text.replace(insert_marker, helpers + insert_marker, 1)

route_marker = """        if (normalizedMethod === 'POST' && path.length === 1 && path[0] === 'prepare') {"""
routes = """        if (normalizedMethod === 'GET' && path.length === 2 && path[0] === 'catalog') {
            const workflows = await creatorWorkflowCatalog(path[1], options);
            return creatorJson({ workflows });
        }
        if (normalizedMethod === 'GET' && path.length === 2 && path[0] === 'inputs') {
            const schema = await creatorWorkflowInputs(path[1], options);
            return creatorJson(schema);
        }
"""
if route_marker not in text:
    raise SystemExit("workflow route insertion marker not found")
text = text.replace(route_marker, routes + route_marker, 1)
write(path, text)


# ---------------------------------------------------------------------------
# Workflow Studio: secure Project reads + durable run restore and refresh.
# ---------------------------------------------------------------------------
path = "packages/studio/src/components/WorkflowStudio.jsx"
text = read(path)
text = replace_once(
    text,
    """  project = null,\n  onProjectRefresh,\n}) {""",
    """  project = null,\n  onProjectRefresh,\n  initialAction = null,\n}) {""",
    "WorkflowStudio props",
)

wait_marker = """function wait(milliseconds) {\n  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));\n}\n"""
form_helper = """
function creatorWorkflowForm(schema, project) {
  const initial = {};
  const storyboardScenes = Array.isArray(project?.storyboard?.scenes) ? project.storyboard.scenes : [];
  const storyboardScene = storyboardScenes.find((scene) => scene.id === project?.storyboard?.selectedSceneId) || storyboardScenes[0] || null;
  Object.entries(schema?.properties || {}).forEach(([key, prop]) => {
    const configured = prop.default || (Array.isArray(prop.examples) ? prop.examples[0] : prop.examples) || "";
    const lowerKey = key.toLowerCase();
    if (configured || !storyboardScene) initial[key] = configured;
    else if (lowerKey.includes("image")) initial[key] = storyboardScene.imageUrl || "";
    else if (lowerKey.includes("video")) initial[key] = storyboardScene.videoUrl || "";
    else if (lowerKey.includes("text") || lowerKey.includes("prompt")) initial[key] = storyboardScene.prompt || storyboardScene.title || "";
    else initial[key] = configured;
  });
  return initial;
}
"""
text = replace_once(text, wait_marker, wait_marker + form_helper, "Workflow form helper")

text = replace_once(
    text,
    """      setResult(null);\n      setError(null);\n      \n      const targetTab""",
    """      setResult(null);\n      setError(null);\n      setCreatorRun(null);\n      \n      const targetTab""",
    "Workflow selection reset",
)

state_marker = """  const [creatorRun, setCreatorRun] = useState(null);\n  \n\n  // Handlers defined early so they can be used in effects"""
action_effect = """  const [creatorRun, setCreatorRun] = useState(null);

  useEffect(() => {
    const workflowId = initialAction?.parameters?.workflowId;
    if (!workflowId || !["workflow.open", "workflow.run"].includes(initialAction?.action)) return;
    router.push(`/workflow/${encodeURIComponent(workflowId)}/playground`);
  }, [initialAction?.action, initialAction?.parameters?.workflowId, router]);
  

  // Handlers defined early so they can be used in effects"""
text = replace_once(text, state_marker, action_effect, "Selena Workflow handoff")

start = """  // Dedicated data fetching effect for the active workflow\n  useEffect(() => {"""
end = """  const handleCreateWorkflow = useCallback("""
new_details = """  // Dedicated data fetching effect for the active workflow.
  // Project mode uses the Creator-authenticated server boundary so the browser
  // never needs a MuAPI key just to browse/run a workflow.
  useEffect(() => {
    if (!selectedWorkflow?.id || (!project?.id && !apiKey)) return;
    let active = true;

    async function loadWorkflowDetails() {
      try {
        setLoading(true);
        const wfId = selectedWorkflow.id;

        if (project?.id) {
          const response = await creatorWorkflowRequest(`inputs/${encodeURIComponent(wfId)}`);
          if (!active) return;
          const schema = response.input_data || response;
          setInputSchema(schema);
          setFormData(creatorWorkflowForm(schema, project));
          setNodeSchemas(null);
          setWorkflowDef(null);
          return;
        }

        const results = await Promise.allSettled([
          getWorkflowInputs(apiKey, wfId),
          getAllNodeSchemas(apiKey, wfId),
          getWorkflowData(apiKey, wfId),
        ]);
        if (!active) return;

        if (results[0].status === "fulfilled") {
          const response = results[0].value;
          const schema = response.input_data || response;
          setInputSchema(schema);
          setFormData(creatorWorkflowForm(schema, project));
        } else {
          console.warn("Input schema not available for this workflow:", results[0].reason);
          setInputSchema(null);
          setFormData({});
        }

        const nodes = results[1].status === "fulfilled" ? results[1].value : [];
        const def = results[2].status === "fulfilled" ? results[2].value : { nodes: [], edges: [] };
        setNodeSchemas(nodes);
        setWorkflowDef(def);
        if (results[1].status === "rejected" || results[2].status === "rejected") {
          console.error("Builder components failed to load:", results[1].reason, results[2].reason);
          if (!nodes.length && !def.nodes?.length) setError("Failed to load full builder data. Some features may be disabled.");
        }
      } catch (err) {
        if (!active) return;
        console.error("Critical error loading workflow details:", err);
        setError("Critical error loading workflow: " + err.message);
        setNodeSchemas([]);
        setWorkflowDef({ nodes: [], edges: [] });
      } finally {
        if (active) setLoading(false);
      }
    }

    loadWorkflowDetails();
    return () => { active = false; };
  }, [selectedWorkflow?.id, apiKey, project?.id, project?.storyboard?.selectedSceneId]);

"""
text = replace_between(text, start, end, new_details, "Workflow details effect")

load_start = """  useEffect(() => {\n    async function loadWorkflows() {"""
load_end = """  const finishCreatorRun = useCallback("""
new_load = """  useEffect(() => {
    let active = true;
    async function loadWorkflows() {
      try {
        setLoading(true);
        let data = [];
        if (project?.id) {
          const catalog = activeMainTab === "templates" ? "templates" : activeMainTab === "my-workflows" ? "mine" : "published";
          const value = await creatorWorkflowRequest(`catalog/${catalog}`);
          data = Array.isArray(value.workflows) ? value.workflows : [];
        } else if (apiKey) {
          if (activeMainTab === "templates") data = await getTemplateWorkflows(apiKey);
          else if (activeMainTab === "my-workflows") data = await getUserWorkflows(apiKey);
          else if (activeMainTab === "published") data = await getPublishedWorkflows(apiKey);
        }
        if (active) setWorkflows(data);
      } catch (err) {
        if (!active) return;
        console.error("Failed to load workflows:", err);
        setError("Failed to load workflows list.");
      } finally {
        if (active) setLoading(false);
      }
    }
    loadWorkflows();
    return () => { active = false; };
  }, [apiKey, activeMainTab, project?.id]);

  useEffect(() => {
    if (!project?.id || !selectedWorkflow?.id || creatorRun?.id) return;
    let active = true;
    creatorWorkflowRequest(`list/${encodeURIComponent(project.id)}`)
      .then((value) => {
        if (!active) return;
        const latest = (Array.isArray(value.runs) ? value.runs : []).find((run) => run.workflowId === selectedWorkflow.id) || null;
        setCreatorRun(latest);
        if (latest?.status === "completed") {
          setResult({ creatorRun: latest, outputs: [] });
          setError(null);
        } else if (latest?.status === "failed") {
          setResult(null);
          setError(latest.error || "Workflow execution failed.");
        }
      })
      .catch((err) => {
        if (active) setError(err.message || "Saved Workflow run status could not be restored.");
      });
    return () => { active = false; };
  }, [creatorRun?.id, project?.id, selectedWorkflow?.id]);

"""
text = replace_between(text, load_start, load_end, new_load, "Workflow list/restore effects")

poll_marker = """  const handleRun = async (e) => {"""
refresh_handler = """  const handleRefreshCreatorRun = async () => {
    if (!project?.id || !creatorRun?.id || isExecuting) return;
    setIsExecuting(true);
    setError(null);
    try {
      const value = await creatorWorkflowRequest(`status/${encodeURIComponent(project.id)}/${encodeURIComponent(creatorRun.id)}`);
      setCreatorRun(value.run);
      if (!["queued", "running"].includes(value.run?.status)) await finishCreatorRun(value.run);
    } catch (err) {
      setError(err.message || "Workflow status could not be refreshed.");
    } finally {
      setIsExecuting(false);
    }
  };

"""
if poll_marker not in text:
    raise SystemExit("Workflow refresh handler insertion marker not found")
text = text.replace(poll_marker, refresh_handler + poll_marker, 1)

empty_marker = """                {!isExecuting && !result && !error && !creatorRun && ("""
status_cards = """                {!isExecuting && !result && !error && ["queued", "running"].includes(creatorRun?.status) && (
                  <div className="w-full max-w-lg rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.05] p-6">
                    <div className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-200">{creatorRun.status}</div>
                    <h3 className="mt-2 text-lg font-bold text-white">Workflow run is in progress</h3>
                    <p className="mt-2 text-sm leading-6 text-white/45">This durable run was restored from the Project. Refresh status to check for new node results without submitting it again.</p>
                    {creatorRun.nodeStates?.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {creatorRun.nodeStates.map((node) => <span key={node.id} className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-white/50">{node.id} · {node.status}</span>)}
                      </div>
                    )}
                    <button type="button" onClick={handleRefreshCreatorRun} className="mt-5 rounded-xl bg-cyan-200 px-4 py-2.5 text-[10px] font-black uppercase tracking-wider text-black hover:bg-white">Refresh status</button>
                  </div>
                )}

                {!isExecuting && !result && !error && creatorRun?.status === "cancelled" && (
                  <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-white/[0.04] p-6">
                    <div className="text-[10px] font-black uppercase tracking-[0.2em] text-white/45">Cancelled</div>
                    <h3 className="mt-2 text-lg font-bold text-white">This Workflow run was cancelled</h3>
                    <button type="button" onClick={handleRetryCreatorRun} className="mt-5 rounded-xl bg-white px-4 py-2.5 text-[10px] font-black uppercase tracking-wider text-black">Prepare retry</button>
                  </div>
                )}

"""
if empty_marker not in text:
    raise SystemExit("Workflow status card insertion marker not found")
text = text.replace(empty_marker, status_cards + empty_marker, 1)
write(path, text)


# ---------------------------------------------------------------------------
# Shell: allow secure Project Workflow mode without browser BYOK, and route
# Selena's review-only Workflow action into the Workflow workspace.
# ---------------------------------------------------------------------------
path = "components/StandaloneShell.js"
text = read(path)
text = replace_once(
    text,
    """      'workflow.open': '/studio/workflows',""",
    """      'workflow.open': '/studio/workflows',\n      'workflow.run': '/studio/workflows',""",
    "Selena Workflow shell target",
)
text = replace_once(
    text,
    """case 'workflows': return <WorkflowStudio {...legacyShared} project={currentProject} onProjectRefresh={(projectId) => openProject(projectId || currentProject?.id)} isHeaderVisible={isHeaderVisible} onToggleHeader={setIsHeaderVisible} />;""",
    """case 'workflows': return <WorkflowStudio {...legacyShared} project={currentProject} initialAction={selenaAction} onProjectRefresh={(projectId) => openProject(projectId || currentProject?.id)} isHeaderVisible={isHeaderVisible} onToggleHeader={setIsHeaderVisible} />;""",
    "Workflow Studio shell props",
)
text = replace_once(
    text,
    """          {!apiKey && LEGACY_DESTINATIONS.has(destinationId) && destinationId !== 'provider-settings'\n            ? <LegacyProviderSettings""",
    """          {!apiKey && LEGACY_DESTINATIONS.has(destinationId) && destinationId !== 'provider-settings' && !(destinationId === 'workflows' && (projectsLoading || currentProject?.id))\n            ? <LegacyProviderSettings""",
    "secure Workflow shell gate",
)
write(path, text)


# ---------------------------------------------------------------------------
# Selena allowlist: review-only workflow.run. Actual execution still requires
# the Workflow gateway's explicit confirm:true boundary.
# ---------------------------------------------------------------------------
path = "src/lib/selenaOrchestrator.js"
text = read(path)
workflow_open = """    'workflow.open': Object.freeze({
        label: 'Open Workflows',
        destination: '/studio/workflows',
        requiresApproval: false,
        available: true,
        sideEffect: null,
        fields: Object.freeze(['workflowId']),
    }),
"""
workflow_actions = workflow_open + """    'workflow.run': Object.freeze({
        label: 'Review Workflow Run',
        destination: '/studio/workflows',
        requiresApproval: true,
        available: true,
        sideEffect: 'Opens the Workflow for review. Provider execution still requires a separate explicit Approve & Run confirmation.',
        fields: Object.freeze(['workflowId']),
    }),
"""
text = replace_once(text, workflow_open, workflow_actions, "Selena Workflow action")
write(path, text)


# ---------------------------------------------------------------------------
# Regression tests.
# ---------------------------------------------------------------------------
Path("tests/security/creatorWorkflowReadBoundary.test.js").write_text(r'''import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreatorSession, creatorCookieSettings } from '../../src/lib/creatorAuth.js';
import { handleCreatorWorkflowRoute } from '../../src/lib/creatorWorkflowGateway.js';
import { createCreatorProject, creatorProjectStoreForTests } from '../../src/lib/creatorProjectStore.js';
import { resetRateLimitStore } from '../../src/lib/rateLimit.js';

const baseEnv = {
    BLOB_READ_WRITE_TOKEN: 'vercel-blob-workflow-read-boundary-token-long-enough',
    CREATOR_SESSION_SECRET: 'creator-workflow-read-boundary-secret-longer-than-thirty-two-characters',
    CREATOR_GITHUB_ALLOWED_USER_IDS: '12345678',
    CREATOR_GITHUB_ALLOWED_LOGINS: 'lalambert1982-eng',
    CREATOR_STUDIO_RATE_LIMIT: '100',
    CREATOR_STUDIO_STATUS_RATE_LIMIT: '100',
    CONTENT_SAFETY_MODE: 'enforce',
    MUAPI_KEY_MODE: 'production',
    MUAPI_PRODUCTION_API_KEY: 'muapi-production-workflow-read-boundary-key',
    MUAPI_ALLOW_PAID_GENERATION: 'false',
};
const paidEnv = { ...baseEnv, MUAPI_ALLOW_PAID_GENERATION: 'true' };
const user = { id: 12345678, login: 'lalambert1982-eng' };
const projectId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';

function request(path, { method = 'GET', body, env = baseEnv } = {}) {
    const session = createCreatorSession(user, { env });
    const cookieName = creatorCookieSettings(env).sessionName;
    return new Request(`https://local.test/api/creator/workflows/${path}`, {
        method,
        headers: {
            cookie: `${cookieName}=${session}`,
            origin: 'https://local.test',
            'sec-fetch-site': 'same-origin',
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
}

test('Project Workflow catalog reads use the server key without enabling paid generation', async () => {
    resetRateLimitStore();
    let providerCalled = false;
    const response = await handleCreatorWorkflowRoute(request('catalog/templates'), {
        path: ['catalog', 'templates'],
        method: 'GET',
        env: baseEnv,
        fetchImpl: async (url, options) => {
            providerCalled = true;
            assert.equal(String(url).endsWith('/workflow/get-template-workflows'), true);
            assert.equal(options.headers['x-api-key'], baseEnv.MUAPI_PRODUCTION_API_KEY);
            return new Response(JSON.stringify([{
                workflow_id: 'launch-video-v1',
                name: 'Launch Video',
                category: 'Video',
                internal_secret: 'must-not-leak',
            }]), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    assert.equal(response.status, 200);
    assert.equal(providerCalled, true);
    const body = await response.json();
    assert.deepEqual(body.workflows, [{
        id: 'launch-video-v1',
        workflow_id: 'launch-video-v1',
        name: 'Launch Video',
        category: 'Video',
        user_name: null,
    }]);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('must-not-leak'), false);
    assert.equal(serialized.includes(baseEnv.MUAPI_PRODUCTION_API_KEY), false);
});

test('Project Workflow input-schema reads are bounded and strip credential-shaped fields', async () => {
    resetRateLimitStore();
    const response = await handleCreatorWorkflowRoute(request('inputs/launch-video-v1'), {
        path: ['inputs', 'launch-video-v1'],
        method: 'GET',
        env: baseEnv,
        fetchImpl: async (url, options) => {
            assert.equal(String(url).endsWith('/workflow/launch-video-v1/api-inputs'), true);
            assert.equal(options.headers['x-api-key'], baseEnv.MUAPI_PRODUCTION_API_KEY);
            return new Response(JSON.stringify({
                input_data: {
                    type: 'object',
                    properties: {
                        text_prompt: { type: 'string', title: 'Prompt', description: 'Describe the video.' },
                        api_key: { type: 'string', default: 'provider-secret-should-not-return' },
                    },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.input_data.properties), ['text_prompt']);
    assert.equal(JSON.stringify(body).includes('provider-secret-should-not-return'), false);
});

test('paid generation switch still blocks new Workflow submission in production', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await createCreatorProject(user, { name: 'Read Boundary Project' }, {
        env: baseEnv,
        blobStore,
        idGenerator: () => projectId,
    });
    const prepared = await handleCreatorWorkflowRoute(request('prepare', {
        method: 'POST',
        body: { projectId, workflowId: 'launch-video-v1', inputs: {} },
    }), { path: ['prepare'], env: baseEnv, blobStore, idGenerator: () => runId });
    assert.equal(prepared.status, 201);

    let providerCalled = false;
    const run = await handleCreatorWorkflowRoute(request('run', {
        method: 'POST',
        body: { projectId, runId, confirm: true },
    }), {
        path: ['run'],
        env: baseEnv,
        blobStore,
        fetchImpl: async () => { providerCalled = true; return new Response('{}'); },
    });
    assert.equal(run.status, 503);
    assert.equal((await run.json()).code, 'workflow_provider_unconfigured');
    assert.equal(providerCalled, false);
});

test('already-approved Workflow status can finish after the paid switch is turned off', async () => {
    resetRateLimitStore();
    const blobStore = creatorProjectStoreForTests();
    await createCreatorProject(user, { name: 'Status Project' }, {
        env: paidEnv,
        blobStore,
        idGenerator: () => projectId,
    });
    const prepared = await handleCreatorWorkflowRoute(request('prepare', {
        method: 'POST', env: paidEnv,
        body: { projectId, workflowId: 'launch-video-v1', inputs: {} },
    }), { path: ['prepare'], env: paidEnv, blobStore, idGenerator: () => runId });
    assert.equal(prepared.status, 201);

    const submitted = await handleCreatorWorkflowRoute(request('run', {
        method: 'POST', env: paidEnv,
        body: { projectId, runId, confirm: true },
    }), {
        path: ['run'],
        env: paidEnv,
        blobStore,
        fetchImpl: async () => new Response(JSON.stringify({ run_id: 'provider-run-1', status: 'queued' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }),
    });
    assert.equal(submitted.status, 202);

    const status = await handleCreatorWorkflowRoute(request(`status/${projectId}/${runId}`, { env: baseEnv }), {
        path: ['status', projectId, runId],
        method: 'GET',
        env: baseEnv,
        blobStore,
        assetIdGenerator: () => assetId,
        fetchImpl: async (url, options) => {
            assert.equal(String(url).endsWith('/workflow/run/provider-run-1/api-outputs'), true);
            assert.equal(options.headers['x-api-key'], baseEnv.MUAPI_PRODUCTION_API_KEY);
            return new Response(JSON.stringify({
                status: 'completed',
                outputs: ['https://cdn.muapi.ai/workflows/final.mp4'],
                node_runs: [{ node_id: 'final', status: 'completed' }],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.run.status, 'completed');
    assert.deepEqual(body.run.outputAssetIds, [assetId]);
});
''', encoding="utf-8")

Path("tests/security/selenaWorkflowAction.test.js").write_text(r'''import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSelenaPlan } from '../../src/lib/selenaOrchestrator.js';

test('Selena workflow.run is server-defined, approval-gated, and cannot carry arbitrary provider fields', () => {
    const plan = normalizeSelenaPlan({
        structuredOutput: {
            message: 'Review the workflow.',
            plan: ['Open the workflow for review.'],
            referencedAssets: [],
            suggestedActions: [{
                action: 'workflow.run',
                requiresApproval: false,
                destination: 'https://attacker.test',
                parameters: {
                    workflowId: 'launch-video-v1',
                    apiKey: 'browser-secret',
                    confirm: true,
                    providerRunId: 'attacker-run',
                },
            }],
        },
    });
    assert.equal(plan.suggestedActions.length, 1);
    const action = plan.suggestedActions[0];
    assert.equal(action.action, 'workflow.run');
    assert.equal(action.destination, '/studio/workflows');
    assert.equal(action.requiresApproval, true);
    assert.deepEqual(action.parameters, { workflowId: 'launch-video-v1' });
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes('browser-secret'), false);
    assert.equal(serialized.includes('attacker.test'), false);
    assert.equal(serialized.includes('attacker-run'), false);
});
''', encoding="utf-8")

Path("tests/workflowProjectModeIntegration.test.js").write_text(r'''import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowSource = await readFile(new URL('../packages/studio/src/components/WorkflowStudio.jsx', import.meta.url), 'utf8');
const shellSource = await readFile(new URL('../components/StandaloneShell.js', import.meta.url), 'utf8');

test('Project Workflow mode uses Creator-authenticated catalog/input/run routes and restores durable runs', () => {
    assert.match(workflowSource, /creatorWorkflowRequest\(`catalog\/\$\{catalog\}`\)/);
    assert.match(workflowSource, /creatorWorkflowRequest\(`inputs\/\$\{encodeURIComponent\(wfId\)\}`\)/);
    assert.match(workflowSource, /creatorWorkflowRequest\(`list\/\$\{encodeURIComponent\(project\.id\)\}`\)/);
    assert.match(workflowSource, /Refresh status/);
    assert.match(workflowSource, /initialAction\?\.parameters\?\.workflowId/);
});

test('Creator shell does not require browser BYOK for an opened Project Workflow', () => {
    assert.match(shellSource, /destinationId === 'workflows' && \(projectsLoading \|\| currentProject\?\.id\)/);
    assert.match(shellSource, /'workflow\.run': '\/studio\/workflows'/);
    assert.match(shellSource, /<WorkflowStudio[^>]*initialAction=\{selenaAction\}/);
});
''', encoding="utf-8")

print("Workflow V1 integration hardening patch applied")
