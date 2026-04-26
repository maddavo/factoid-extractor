// Sage Phase 1 Factoid Extractor for SillyTavern
// v0.1.2 — review-first, Phase 1 only: CurrentScene + RecentEvents. Human-readable proposal summary.

const MODULE_NAME = 'sage_phase1_factoid_extractor';
const MODULE_TITLE = 'Sage Phase 1 Factoid Extractor';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    autoRun: true,
    trigger: 'assistant', // assistant | user_and_assistant
    endpoint: '/proxy/http://127.0.0.1:1234/v1/chat/completions',
    model: 'local-model',
    apiKey: '',
    temperature: 0,
    maxTokens: 900,
    recentMessageLimit: 10,
    debounceMs: 1500,
    responseFormatJson: false,
    autoApply: false,
    keepResolvedEvents: false,
    unresolvedEventLimit: 6,
    debug: false
});

const EMPTY_SCENE = Object.freeze({
    location_ref: '',
    present_entities: [],
    nearby_objects: [],
    surroundings_summary: '',
    last_updated_turn: 0
});

const EXTRACTION_SYSTEM_PROMPT = `You are a continuity fact extractor for a SillyTavern roleplay chat.
You are not Sage. Do not roleplay. Do not continue the scene.
Your only job is to propose sparse Phase 1 state deltas for a continuity layer.

PHASE 1 STATE ONLY:
1. CurrentScene:
- current location
- currently present people/entities
- nearby practical objects
- object locations
- one short surroundings summary only if it materially anchors the scene

2. RecentEvents:
- only recent events that changed practical state
- examples: object moved, object broken, object hidden, item handed over, item lost/found, promise made, task/deadline introduced, urgent interruption, person entered/left if it affects the scene, factual reminder became relevant

STRICT RULES:
- Prefer no update over guessing.
- Extract only explicit or strongly established facts.
- Do not infer hidden motives.
- Do not invent.
- Preserve actor/object names.
- Avoid pronouns in stored facts.
- Do not store mood as a scene fact.
- Do not store generic flirt lines, banter, emotional colour, or decorative ambience unless it changes practical state.
- Do not treat decorative assistant narration as authoritative when it invents unsupported details.
- If assistant narration changes a practical state, include it only when the fact is clear and consistent with prior established context.
- If new explicit text contradicts old state, prefer the latest explicit fact and include a rejected_candidate or uncertainty note.
- Cap output to the most important Phase 1 facts. Sparse is better than complete.
- Output valid JSON only. No Markdown. No prose outside JSON.

OUTPUT SHAPE:
{
  "scene_update": {
    "location_ref": null,
    "present_entities_add": [],
    "present_entities_remove": [],
    "nearby_objects_add_or_update": [],
    "nearby_objects_remove": [],
    "surroundings_summary": null
  },
  "recent_event_updates": [
    {
      "summary": "",
      "causal_result": "",
      "resolved": false,
      "importance_score": 0,
      "evidence": ""
    }
  ],
  "resolved_event_updates": [
    {
      "matches_existing_event": "",
      "resolution": "",
      "evidence": ""
    }
  ],
  "rejected_candidates": [
    {
      "candidate": "",
      "reason": ""
    }
  ],
  "no_update_reason": ""
}

Use null or empty arrays for no change.
For nearby_objects_add_or_update, use objects like {"name":"Davo's mug","location":"Sage's study desk","evidence":"Turn 14: ..."}.
Evidence must point to source turn numbers or short quotes from the chat text.`;

function ctx() {
    return globalThis.SillyTavern?.getContext?.() || {};
}

function settings() {
    const context = ctx();
    context.extensionSettings = context.extensionSettings || {};
    context.extensionSettings[MODULE_NAME] = context.extensionSettings[MODULE_NAME] || {};
    const s = context.extensionSettings[MODULE_NAME];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function saveSettings() {
    const context = ctx();
    context.saveSettingsDebounced?.();
}

function defaultMetadata() {
    return {
        version: '0.1.0',
        currentScene: structuredCloneSafe(EMPTY_SCENE),
        recentEvents: [],
        pendingProposals: [],
        auditLog: [],
        lastProcessedSignature: '',
        lastRunAt: null,
        lastError: ''
    };
}

function metadata() {
    const context = ctx();
    context.chatMetadata = context.chatMetadata || {};
    context.chatMetadata[MODULE_NAME] = context.chatMetadata[MODULE_NAME] || defaultMetadata();
    const m = context.chatMetadata[MODULE_NAME];
    if (!m.currentScene) m.currentScene = structuredCloneSafe(EMPTY_SCENE);
    if (!Array.isArray(m.recentEvents)) m.recentEvents = [];
    if (!Array.isArray(m.pendingProposals)) m.pendingProposals = [];
    if (!Array.isArray(m.auditLog)) m.auditLog = [];
    return m;
}

async function saveMetadataNow() {
    const context = ctx();
    if (typeof context.saveMetadata === 'function') {
        await context.saveMetadata();
    } else if (typeof context.saveMetadataDebounced === 'function') {
        context.saveMetadataDebounced();
    }
}

function structuredCloneSafe(obj) {
    try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); }
}

function logDebug(...args) {
    if (settings().debug) console.debug(`[${MODULE_TITLE}]`, ...args);
}

function toastInfo(message) { globalThis.toastr?.info?.(message, MODULE_TITLE); }
function toastWarn(message) { globalThis.toastr?.warning?.(message, MODULE_TITLE); }
function toastError(message) { globalThis.toastr?.error?.(message, MODULE_TITLE); }

function sanitizeText(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function roleOfMessage(message) {
    if (message?.is_system) return 'system';
    if (message?.is_user) return 'user';
    if (message?.extra?.type === 'system') return 'system';
    return 'assistant';
}

function speakerOfMessage(message, fallbackRole) {
    return sanitizeText(message?.name || message?.original_avatar || fallbackRole || 'unknown');
}

function getRecentTurns(limit) {
    const chat = ctx().chat || [];
    const start = Math.max(0, chat.length - Number(limit || 10));
    return chat.slice(start).map((message, offset) => {
        const absoluteTurn = start + offset;
        const role = roleOfMessage(message);
        return {
            turn: absoluteTurn,
            role,
            speaker: speakerOfMessage(message, role),
            text: sanitizeText(message?.mes)
        };
    }).filter(t => t.text.length > 0);
}

function chatSignature() {
    const chat = ctx().chat || [];
    const last = chat[chat.length - 1];
    const prev = chat[chat.length - 2];
    return JSON.stringify({
        length: chat.length,
        last: sanitizeText(last?.mes).slice(0, 500),
        prev: sanitizeText(prev?.mes).slice(0, 200)
    });
}

function buildExtractorUserPayload() {
    const s = settings();
    const m = metadata();
    return JSON.stringify({
        task: 'Propose Phase 1 continuity state delta from recent SillyTavern chat turns.',
        previous_CurrentScene: m.currentScene,
        previous_RecentEvents: m.recentEvents,
        recent_chat_turns: getRecentTurns(s.recentMessageLimit)
    }, null, 2);
}

function buildLmStudioJsonSchemaResponseFormat() {
    const stringOrNull = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    const stringArray = { type: 'array', items: { type: 'string' } };
    return {
        type: 'json_schema',
        json_schema: {
            name: 'sage_phase1_factoid_delta',
            schema: {
                type: 'object',
                properties: {
                    scene_update: {
                        type: 'object',
                        properties: {
                            location_ref: stringOrNull,
                            present_entities_add: stringArray,
                            present_entities_remove: stringArray,
                            nearby_objects_add_or_update: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        location: { type: 'string' },
                                        evidence: { type: 'string' }
                                    }
                                }
                            },
                            nearby_objects_remove: stringArray,
                            surroundings_summary: stringOrNull
                        },
                        required: ['location_ref', 'present_entities_add', 'present_entities_remove', 'nearby_objects_add_or_update', 'nearby_objects_remove', 'surroundings_summary']
                    },
                    recent_event_updates: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                summary: { type: 'string' },
                                causal_result: { type: 'string' },
                                resolved: { type: 'boolean' },
                                importance_score: { type: 'number' },
                                evidence: { type: 'string' }
                            },
                            required: ['summary', 'causal_result', 'resolved', 'importance_score', 'evidence']
                        }
                    },
                    resolved_event_updates: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                matches_existing_event: { type: 'string' },
                                resolution: { type: 'string' },
                                evidence: { type: 'string' }
                            },
                            required: ['matches_existing_event', 'resolution', 'evidence']
                        }
                    },
                    rejected_candidates: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                candidate: { type: 'string' },
                                reason: { type: 'string' }
                            },
                            required: ['candidate', 'reason']
                        }
                    },
                    no_update_reason: { type: 'string' }
                },
                required: ['scene_update', 'recent_event_updates', 'resolved_event_updates', 'rejected_candidates', 'no_update_reason']
            }
        }
    };
}

async function callExtractor(promptPayload) {
    const s = settings();
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;

    const body = {
        model: s.model || 'local-model',
        messages: [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: promptPayload }
        ],
        temperature: Number(s.temperature ?? 0),
        max_tokens: Number(s.maxTokens ?? 900),
        stream: false
    };

    if (s.responseFormatJson) {
        body.response_format = buildLmStudioJsonSchemaResponseFormat();
    }

    const response = await fetch(s.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Extractor endpoint HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    if (!content) throw new Error('Extractor returned no content.');
    return parseJsonContent(content);
}

function parseJsonContent(content) {
    let text = String(content || '').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(text); } catch {}

    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
        const candidate = text.slice(first, last + 1);
        return JSON.parse(candidate);
    }
    throw new Error(`Could not parse extractor JSON: ${text.slice(0, 300)}`);
}

function normalizeProposal(raw) {
    const normalized = {
        scene_update: {
            location_ref: raw?.scene_update?.location_ref ?? null,
            present_entities_add: Array.isArray(raw?.scene_update?.present_entities_add) ? raw.scene_update.present_entities_add : [],
            present_entities_remove: Array.isArray(raw?.scene_update?.present_entities_remove) ? raw.scene_update.present_entities_remove : [],
            nearby_objects_add_or_update: Array.isArray(raw?.scene_update?.nearby_objects_add_or_update) ? raw.scene_update.nearby_objects_add_or_update : [],
            nearby_objects_remove: Array.isArray(raw?.scene_update?.nearby_objects_remove) ? raw.scene_update.nearby_objects_remove : [],
            surroundings_summary: raw?.scene_update?.surroundings_summary ?? null
        },
        recent_event_updates: Array.isArray(raw?.recent_event_updates) ? raw.recent_event_updates : [],
        resolved_event_updates: Array.isArray(raw?.resolved_event_updates) ? raw.resolved_event_updates : [],
        rejected_candidates: Array.isArray(raw?.rejected_candidates) ? raw.rejected_candidates : [],
        no_update_reason: raw?.no_update_reason || ''
    };

    normalized.recent_event_updates = normalized.recent_event_updates
        .filter(e => e && (e.summary || e.causal_result || e.evidence))
        .map(e => ({
            summary: sanitizeText(e.summary),
            causal_result: sanitizeText(e.causal_result),
            resolved: Boolean(e.resolved),
            importance_score: Number(e.importance_score || 0),
            evidence: sanitizeText(e.evidence)
        }));

    normalized.resolved_event_updates = normalized.resolved_event_updates
        .filter(e => e && (e.matches_existing_event || e.resolution || e.evidence))
        .map(e => ({
            matches_existing_event: sanitizeText(e.matches_existing_event),
            resolution: sanitizeText(e.resolution),
            evidence: sanitizeText(e.evidence)
        }));

    normalized.rejected_candidates = normalized.rejected_candidates
        .filter(e => e && (e.candidate || e.reason))
        .map(e => ({ candidate: sanitizeText(e.candidate), reason: sanitizeText(e.reason) }));

    normalized.scene_update.nearby_objects_add_or_update = normalized.scene_update.nearby_objects_add_or_update
        .filter(o => o && (o.name || o.location))
        .map(o => ({
            name: sanitizeText(o.name),
            location: sanitizeText(o.location),
            evidence: sanitizeText(o.evidence)
        }));

    normalized.scene_update.nearby_objects_remove = normalized.scene_update.nearby_objects_remove.map(sanitizeText).filter(Boolean);
    normalized.scene_update.present_entities_add = normalized.scene_update.present_entities_add.map(sanitizeText).filter(Boolean);
    normalized.scene_update.present_entities_remove = normalized.scene_update.present_entities_remove.map(sanitizeText).filter(Boolean);
    if (normalized.scene_update.location_ref !== null) normalized.scene_update.location_ref = sanitizeText(normalized.scene_update.location_ref);
    if (normalized.scene_update.surroundings_summary !== null) normalized.scene_update.surroundings_summary = sanitizeText(normalized.scene_update.surroundings_summary);

    return normalized;
}

function hasSubstantiveDelta(delta) {
    const s = delta?.scene_update || {};
    return Boolean(
        s.location_ref ||
        s.surroundings_summary ||
        s.present_entities_add?.length ||
        s.present_entities_remove?.length ||
        s.nearby_objects_add_or_update?.length ||
        s.nearby_objects_remove?.length ||
        delta?.recent_event_updates?.length ||
        delta?.resolved_event_updates?.length
    );
}

let inFlight = false;
let queuedReason = '';
let debounceTimer = null;

function scheduleExtraction(reason) {
    const s = settings();
    if (!s.enabled || !s.autoRun) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runExtraction(reason), Number(s.debounceMs || 1500));
}

async function runExtraction(reason = 'manual') {
    const s = settings();
    const m = metadata();
    const sig = chatSignature();

    if (inFlight) {
        queuedReason = reason;
        return;
    }
    if (reason !== 'manual' && sig === m.lastProcessedSignature) {
        logDebug('Skipping duplicate signature.');
        return;
    }

    const recentTurns = getRecentTurns(s.recentMessageLimit);
    if (!recentTurns.length) {
        toastWarn('No chat turns available to extract from.');
        return;
    }

    inFlight = true;
    updateUiStatus('running', `Running extractor (${reason})...`);
    try {
        const promptPayload = buildExtractorUserPayload();
        const raw = await callExtractor(promptPayload);
        const delta = normalizeProposal(raw);
        const proposal = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            created_at: new Date().toISOString(),
            reason,
            chat_signature: sig,
            turn_count: (ctx().chat || []).length,
            status: hasSubstantiveDelta(delta) ? 'pending' : 'no_update',
            delta,
            raw
        };

        m.lastProcessedSignature = sig;
        m.lastRunAt = proposal.created_at;
        m.lastError = '';
        m.pendingProposals.unshift(proposal);
        m.pendingProposals = m.pendingProposals.slice(0, 25);
        m.auditLog.unshift(proposal);
        m.auditLog = m.auditLog.slice(0, 200);

        if (s.autoApply && hasSubstantiveDelta(delta)) {
            applyProposalObject(proposal);
            proposal.status = 'auto_applied';
        }

        await saveMetadataNow();
        updatePanel();
        updateUiStatus('ok', hasSubstantiveDelta(delta) ? 'Extractor proposed update.' : 'Extractor returned no update.');
        if (hasSubstantiveDelta(delta)) toastInfo('Extractor proposed a Phase 1 factoid update.');
    } catch (error) {
        console.error(`[${MODULE_TITLE}]`, error);
        metadata().lastError = String(error?.message || error);
        await saveMetadataNow();
        updatePanel();
        updateUiStatus('bad', `Extractor error: ${metadata().lastError}`);
        toastError(metadata().lastError);
    } finally {
        inFlight = false;
        if (queuedReason) {
            const r = queuedReason;
            queuedReason = '';
            scheduleExtraction(r);
        }
    }
}

function applyProposalById(id) {
    const m = metadata();
    const proposal = m.pendingProposals.find(p => p.id === id) || m.auditLog.find(p => p.id === id);
    if (!proposal) return;
    applyProposalObject(proposal);
    proposal.status = 'applied';
    for (const p of m.auditLog) if (p.id === id) p.status = 'applied';
}

function applyProposalObject(proposal) {
    const m = metadata();
    const delta = proposal.delta;
    const turn = proposal.turn_count || (ctx().chat || []).length;
    const scene = m.currentScene || structuredCloneSafe(EMPTY_SCENE);
    const su = delta.scene_update || {};

    if (su.location_ref) scene.location_ref = su.location_ref;
    if (su.surroundings_summary) scene.surroundings_summary = su.surroundings_summary;

    for (const ent of su.present_entities_add || []) addUnique(scene.present_entities, ent);
    for (const ent of su.present_entities_remove || []) removeByCaseInsensitive(scene.present_entities, ent);

    scene.nearby_objects = Array.isArray(scene.nearby_objects) ? scene.nearby_objects : [];
    for (const removeName of su.nearby_objects_remove || []) {
        scene.nearby_objects = scene.nearby_objects.filter(o => !sameText(o.name, removeName));
    }
    for (const obj of su.nearby_objects_add_or_update || []) {
        if (!obj.name || !obj.location) continue;
        const existing = scene.nearby_objects.find(o => sameText(o.name, obj.name));
        if (existing) {
            existing.location = obj.location;
            existing.evidence = obj.evidence || existing.evidence || '';
            existing.last_updated_turn = turn;
        } else {
            scene.nearby_objects.push({
                name: obj.name,
                location: obj.location,
                evidence: obj.evidence || '',
                last_updated_turn: turn
            });
        }
    }

    if (hasSubstantiveDelta(delta)) scene.last_updated_turn = turn;
    m.currentScene = scene;

    for (const event of delta.recent_event_updates || []) {
        if (!event.summary) continue;
        const duplicate = m.recentEvents.find(e => sameText(e.summary, event.summary));
        if (duplicate) {
            duplicate.causal_result = event.causal_result || duplicate.causal_result;
            duplicate.resolved = Boolean(event.resolved);
            duplicate.importance_score = Math.max(Number(duplicate.importance_score || 0), Number(event.importance_score || 0));
            duplicate.evidence = event.evidence || duplicate.evidence || '';
            duplicate.last_updated_turn = turn;
        } else {
            m.recentEvents.unshift({
                summary: event.summary,
                causal_result: event.causal_result || '',
                resolved: Boolean(event.resolved),
                importance_score: Number(event.importance_score || 0),
                evidence: event.evidence || '',
                created_turn: turn,
                last_updated_turn: turn
            });
        }
    }

    for (const res of delta.resolved_event_updates || []) {
        const matchText = res.matches_existing_event || '';
        const matched = m.recentEvents.find(e => sameText(e.summary, matchText) || e.summary.toLowerCase().includes(matchText.toLowerCase()) || matchText.toLowerCase().includes(e.summary.toLowerCase()));
        if (matched) {
            matched.resolved = true;
            matched.resolution = res.resolution || matched.resolution || 'Resolved.';
            matched.resolution_evidence = res.evidence || matched.resolution_evidence || '';
            matched.last_updated_turn = turn;
        }
    }

    const maxEvents = Math.max(1, Number(settings().unresolvedEventLimit || 6));
    if (!settings().keepResolvedEvents) {
        m.recentEvents = m.recentEvents.filter(e => !e.resolved).slice(0, maxEvents);
    } else {
        m.recentEvents = m.recentEvents.slice(0, Math.max(maxEvents, 12));
    }
}

function rejectProposalById(id) {
    const m = metadata();
    for (const p of m.pendingProposals) if (p.id === id) p.status = 'rejected';
    for (const p of m.auditLog) if (p.id === id) p.status = 'rejected';
}

function addUnique(arr, value) {
    if (!value) return;
    if (!arr.some(x => sameText(x, value))) arr.push(value);
}

function removeByCaseInsensitive(arr, value) {
    const i = arr.findIndex(x => sameText(x, value));
    if (i >= 0) arr.splice(i, 1);
}

function sameText(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function renderPackets() {
    const m = metadata();
    const scene = m.currentScene || EMPTY_SCENE;
    const sceneLines = [];
    if (scene.location_ref) sceneLines.push(`Current location: ${scene.location_ref}`);
    if (scene.present_entities?.length) sceneLines.push(`Present entities: ${scene.present_entities.join(', ')}`);
    if (scene.nearby_objects?.length) {
        for (const obj of scene.nearby_objects) {
            if (obj.name && obj.location) sceneLines.push(`${obj.name}: ${obj.location}`);
        }
    }
    if (scene.surroundings_summary) sceneLines.push(`Surroundings: ${scene.surroundings_summary}`);

    const eventLines = (m.recentEvents || [])
        .filter(e => !e.resolved)
        .slice(0, Number(settings().unresolvedEventLimit || 6))
        .map(e => e.causal_result ? `${e.summary}; result: ${e.causal_result}` : e.summary);

    const scenePacket = `sap_inj_scene:\n[OOC scene facts:\n${sceneLines.map(x => `- ${x}`).join('\n')}\n]`;
    const eventPacket = `sap_inj_recent_events:\n[OOC recent facts:\n${eventLines.map(x => `- ${x}`).join('\n')}\n]`;
    return `${scenePacket}\n\n${eventPacket}`;
}


function nonEmpty(value) {
    return String(value || '').trim().length > 0;
}

function packetLineForObject(obj) {
    if (!obj?.name && !obj?.location) return '';
    if (obj.name && obj.location) return `${obj.name}: ${obj.location}`;
    return obj.name || obj.location || '';
}

function renderProposalSummary(proposal) {
    if (!proposal) return 'No extractor output yet.';
    const delta = proposal.delta || {};
    const su = delta.scene_update || {};
    const lines = [];
    const substantive = hasSubstantiveDelta(delta);

    lines.push(`Status: ${proposal.status || 'unknown'}`);
    lines.push(`Reason: ${proposal.reason || 'unknown'}`);
    lines.push(`Turn count: ${proposal.turn_count ?? 'unknown'}`);
    lines.push('');

    if (!substantive) {
        lines.push('NO UPDATE');
        lines.push(delta.no_update_reason ? `Reason: ${delta.no_update_reason}` : 'Reason: extractor found no Phase 1 continuity change.');
        if (delta.rejected_candidates?.length) {
            lines.push('');
            lines.push('Rejected candidates:');
            for (const r of delta.rejected_candidates) {
                lines.push(`- REJECT ${r.candidate || '(candidate)'} — ${r.reason || 'not Phase 1 / not supported'}`);
            }
        }
        return lines.join('\n');
    }

    lines.push('PROPOSED OOC PACKET CHANGES');
    lines.push('');
    lines.push('sap_inj_scene:');

    let sceneCount = 0;
    if (nonEmpty(su.location_ref)) {
        lines.push(`- SET Current location: ${su.location_ref}`);
        sceneCount++;
    }
    for (const ent of su.present_entities_add || []) {
        lines.push(`- ADD Present entity: ${ent}`);
        sceneCount++;
    }
    for (const ent of su.present_entities_remove || []) {
        lines.push(`- REMOVE Present entity: ${ent}`);
        sceneCount++;
    }
    for (const obj of su.nearby_objects_add_or_update || []) {
        const line = packetLineForObject(obj);
        if (line) {
            lines.push(`- ADD/UPDATE Object location: ${line}`);
            if (obj.evidence) lines.push(`  Evidence: ${obj.evidence}`);
            sceneCount++;
        }
    }
    for (const objName of su.nearby_objects_remove || []) {
        lines.push(`- REMOVE Object/location: ${objName}`);
        sceneCount++;
    }
    if (nonEmpty(su.surroundings_summary)) {
        lines.push(`- SET Surroundings: ${su.surroundings_summary}`);
        sceneCount++;
    }
    if (!sceneCount) lines.push('- No scene packet change proposed.');

    lines.push('');
    lines.push('sap_inj_recent_events:');

    let eventCount = 0;
    for (const ev of delta.recent_event_updates || []) {
        const summary = ev.summary || '(event summary missing)';
        const result = ev.causal_result ? `; result: ${ev.causal_result}` : '';
        lines.push(`- ADD Recent event: ${summary}${result}`);
        if (ev.evidence) lines.push(`  Evidence: ${ev.evidence}`);
        eventCount++;
    }
    for (const res of delta.resolved_event_updates || []) {
        lines.push(`- RESOLVE/REMOVE Recent event: ${res.matches_existing_event || '(existing event)'} → ${res.resolution || 'resolved'}`);
        if (res.evidence) lines.push(`  Evidence: ${res.evidence}`);
        eventCount++;
    }
    if (!eventCount) lines.push('- No recent-events packet change proposed.');

    if (delta.rejected_candidates?.length) {
        lines.push('');
        lines.push('REJECTED BY EXTRACTOR');
        for (const r of delta.rejected_candidates) {
            lines.push(`- REJECT ${r.candidate || '(candidate)'} — ${r.reason || 'not Phase 1 / not supported'}`);
        }
    }

    lines.push('');
    lines.push('OPERATOR DECISION');
    lines.push('- Apply only if every ADD/SET/REMOVE line is explicit, sparse, accurate, and Phase 1 relevant.');
    lines.push('- Reject if any line is guessed, bloated, ambiguous, or based on unsupported assistant narration.');
    return lines.join('\n');
}

function latestProposal() {
    return metadata().pendingProposals?.[0] || null;
}

function copyToClipboard(text) {
    navigator.clipboard?.writeText(text).then(() => toastInfo('Copied to clipboard.')).catch(() => toastWarn('Clipboard copy failed.'));
}

function downloadText(filename, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function exportAuditJson() {
    downloadText('Sage_Phase1_Factoid_Extraction_Audit.json', JSON.stringify(metadata(), null, 2), 'application/json');
}

function exportControllerMarkdown() {
    const m = metadata();
    const total = m.auditLog.length;
    const substantive = m.auditLog.filter(p => hasSubstantiveDelta(p.delta)).length;
    const noUpdate = m.auditLog.filter(p => !hasSubstantiveDelta(p.delta)).length;
    const applied = m.auditLog.filter(p => ['applied', 'auto_applied'].includes(p.status)).length;
    const rejected = m.auditLog.filter(p => p.status === 'rejected').length;
    const pending = m.auditLog.filter(p => p.status === 'pending').length;

    const md = `# Sage Phase 1 Factoid Extraction Live Plugin Run Report\n\n` +
`## Run summary\n\n` +
`- Generated: ${new Date().toISOString()}\n` +
`- Total extractor runs logged: ${total}\n` +
`- Substantive proposed updates: ${substantive}\n` +
`- No-update results: ${noUpdate}\n` +
`- Applied updates: ${applied}\n` +
`- Rejected updates: ${rejected}\n` +
`- Pending updates: ${pending}\n\n` +
`## Current applied state\n\n` +
'```json\n' + JSON.stringify({ currentScene: m.currentScene, recentEvents: m.recentEvents }, null, 2) + '\n```\n\n' +
`## Rendered packet preview\n\n` +
'```text\n' + renderPackets() + '\n```\n\n' +
`## Extractor audit log\n\n` +
'```json\n' + JSON.stringify(m.auditLog, null, 2) + '\n```\n';

    downloadText('Sage_Phase1_Factoid_Extraction_Live_Run_Report.md', md, 'text/markdown');
}

function resetState() {
    if (!confirm('Reset Sage factoid extractor state for this chat?')) return;
    const context = ctx();
    context.chatMetadata[MODULE_NAME] = defaultMetadata();
    saveMetadataNow();
    updatePanel();
    toastInfo('Extractor state reset for current chat.');
}

function updateUiStatus(kind, text) {
    const el = document.querySelector('#sfe_status');
    if (!el) return;
    el.className = kind === 'ok' ? 'sfe-status-ok' : kind === 'bad' ? 'sfe-status-bad' : 'sfe-status-warn';
    el.textContent = text;
}

function updatePanel() {
    const s = settings();
    const m = metadata();

    setInputValue('sfe_enabled', s.enabled, 'checked');
    setInputValue('sfe_autorun', s.autoRun, 'checked');
    setInputValue('sfe_autoapply', s.autoApply, 'checked');
    setInputValue('sfe_debug', s.debug, 'checked');
    setInputValue('sfe_endpoint', s.endpoint);
    setInputValue('sfe_model', s.model);
    setInputValue('sfe_apikey', s.apiKey);
    setInputValue('sfe_recent_limit', s.recentMessageLimit);
    setInputValue('sfe_max_tokens', s.maxTokens);
    setInputValue('sfe_trigger', s.trigger);
    setInputValue('sfe_json_response', s.responseFormatJson, 'checked');

    const latest = latestProposal();
    const summaryPre = document.querySelector('#sfe_latest_summary');
    if (summaryPre) summaryPre.textContent = renderProposalSummary(latest);

    const proposalPre = document.querySelector('#sfe_latest_proposal');
    if (proposalPre) proposalPre.textContent = latest ? JSON.stringify(latest, null, 2) : 'No extractor output yet.';

    const statePre = document.querySelector('#sfe_state_preview');
    if (statePre) statePre.textContent = JSON.stringify({ currentScene: m.currentScene, recentEvents: m.recentEvents }, null, 2);

    const packetPre = document.querySelector('#sfe_packet_preview');
    if (packetPre) packetPre.textContent = renderPackets();

    const countEl = document.querySelector('#sfe_counts');
    if (countEl) {
        const pending = m.pendingProposals.filter(p => p.status === 'pending').length;
        countEl.textContent = `Audit runs: ${m.auditLog.length} | pending: ${pending} | last run: ${m.lastRunAt || 'never'}`;
    }

    if (m.lastError) updateUiStatus('bad', `Last error: ${m.lastError}`);
}

function setInputValue(id, value, prop = 'value') {
    const el = document.getElementById(id);
    if (!el) return;
    if (prop === 'checked') el.checked = Boolean(value);
    else el.value = value ?? '';
}

function bindSetting(id, key, type = 'string') {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
        const s = settings();
        if (type === 'boolean') s[key] = Boolean(el.checked);
        else if (type === 'number') s[key] = Number(el.value);
        else s[key] = el.value;
        saveSettings();
        updatePanel();
    });
}

function installUi() {
    if (document.getElementById('sage_factoid_extractor_panel')) return;
    const html = `
<div id="sage_factoid_extractor_panel" class="sfe-panel">
  <h3>Sage Phase 1 Factoid Extractor</h3>
  <div class="sfe-small">Live extraction of proposed CurrentScene and RecentEvents deltas. Review-first by default.</div>

  <div class="sfe-row"><label><input id="sfe_enabled" type="checkbox"> Enabled</label><label><input id="sfe_autorun" type="checkbox"> Auto-run</label><label><input id="sfe_autoapply" type="checkbox"> Auto-apply proposed deltas</label><label><input id="sfe_debug" type="checkbox"> Debug console logging</label></div>
  <div class="sfe-row"><label for="sfe_trigger">Trigger</label><select id="sfe_trigger"><option value="assistant">After assistant reply</option><option value="user_and_assistant">After user and assistant messages</option></select></div>
  <div class="sfe-row"><label for="sfe_endpoint">Extractor endpoint</label><input id="sfe_endpoint" type="text" spellcheck="false"></div>
  <div class="sfe-row"><label for="sfe_model">Model</label><input id="sfe_model" type="text" spellcheck="false"></div>
  <div class="sfe-row"><label for="sfe_apikey">API key</label><input id="sfe_apikey" type="text" spellcheck="false" placeholder="blank for LM Studio"></div>
  <div class="sfe-row"><label for="sfe_recent_limit">Recent messages</label><input id="sfe_recent_limit" type="number" min="2" max="40" step="1"><label for="sfe_max_tokens">Max output tokens</label><input id="sfe_max_tokens" type="number" min="100" max="4000" step="50"><label><input id="sfe_json_response" type="checkbox"> Request JSON response_format</label></div>

  <div class="sfe-row sfe-buttons">
    <button id="sfe_run_now" class="menu_button">Run extraction now</button>
    <button id="sfe_apply_latest" class="menu_button">Apply latest pending</button>
    <button id="sfe_reject_latest" class="menu_button">Reject latest pending</button>
    <button id="sfe_copy_summary" class="menu_button">Copy review summary</button>
    <button id="sfe_copy_latest" class="menu_button">Copy latest JSON</button>
    <button id="sfe_copy_packets" class="menu_button">Copy OOC packet preview</button>
    <button id="sfe_export_json" class="menu_button">Export audit JSON</button>
    <button id="sfe_export_md" class="menu_button">Export controller MD</button>
    <button id="sfe_reset" class="menu_button">Reset chat state</button>
  </div>

  <div id="sfe_status" class="sfe-status-warn">Idle.</div>
  <div id="sfe_counts" class="sfe-small"></div>

  <details open><summary>Latest proposed packet changes</summary><pre id="sfe_latest_summary"></pre></details>
  <details><summary>Raw latest extractor JSON</summary><pre id="sfe_latest_proposal"></pre></details>
  <details><summary>Applied Phase 1 state</summary><pre id="sfe_state_preview"></pre></details>
  <details><summary>Rendered OOC packet preview</summary><pre id="sfe_packet_preview"></pre></details>
</div>`;

    const host = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2') || document.body;
    host.insertAdjacentHTML('beforeend', html);

    bindSetting('sfe_enabled', 'enabled', 'boolean');
    bindSetting('sfe_autorun', 'autoRun', 'boolean');
    bindSetting('sfe_autoapply', 'autoApply', 'boolean');
    bindSetting('sfe_debug', 'debug', 'boolean');
    bindSetting('sfe_endpoint', 'endpoint');
    bindSetting('sfe_model', 'model');
    bindSetting('sfe_apikey', 'apiKey');
    bindSetting('sfe_recent_limit', 'recentMessageLimit', 'number');
    bindSetting('sfe_max_tokens', 'maxTokens', 'number');
    bindSetting('sfe_trigger', 'trigger');
    bindSetting('sfe_json_response', 'responseFormatJson', 'boolean');

    document.getElementById('sfe_run_now')?.addEventListener('click', () => runExtraction('manual'));
    document.getElementById('sfe_apply_latest')?.addEventListener('click', async () => {
        const p = metadata().pendingProposals.find(x => x.status === 'pending');
        if (!p) return toastWarn('No pending substantive proposal.');
        applyProposalById(p.id);
        await saveMetadataNow();
        updatePanel();
        toastInfo('Latest pending proposal applied.');
    });
    document.getElementById('sfe_reject_latest')?.addEventListener('click', async () => {
        const p = metadata().pendingProposals.find(x => x.status === 'pending');
        if (!p) return toastWarn('No pending substantive proposal.');
        rejectProposalById(p.id);
        await saveMetadataNow();
        updatePanel();
        toastInfo('Latest pending proposal rejected.');
    });
    document.getElementById('sfe_copy_summary')?.addEventListener('click', () => copyToClipboard(renderProposalSummary(latestProposal())));
    document.getElementById('sfe_copy_latest')?.addEventListener('click', () => copyToClipboard(JSON.stringify(latestProposal() || {}, null, 2)));
    document.getElementById('sfe_copy_packets')?.addEventListener('click', () => copyToClipboard(renderPackets()));
    document.getElementById('sfe_export_json')?.addEventListener('click', exportAuditJson);
    document.getElementById('sfe_export_md')?.addEventListener('click', exportControllerMarkdown);
    document.getElementById('sfe_reset')?.addEventListener('click', resetState);

    updatePanel();
}

function installEventHooks() {
    const { eventSource, event_types } = ctx();
    if (!eventSource || !event_types) {
        console.warn(`[${MODULE_TITLE}] eventSource/event_types unavailable.`);
        return;
    }
    eventSource.on(event_types.MESSAGE_RECEIVED, () => scheduleExtraction('MESSAGE_RECEIVED'));
    eventSource.on(event_types.MESSAGE_SENT, () => {
        if (settings().trigger === 'user_and_assistant') scheduleExtraction('MESSAGE_SENT');
    });
    eventSource.on(event_types.MESSAGE_EDITED, () => scheduleExtraction('MESSAGE_EDITED'));
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(updatePanel, 250));
    logDebug('Event hooks installed.');
}

function installMacros() {
    const context = ctx();
    const macros = context.macros;
    try {
        if (macros?.register) {
            macros.register('sap_inj_scene', () => renderPackets().split('\n\nsap_inj_recent_events:')[0], { description: 'Sage Phase 1 rendered scene packet preview' });
            macros.register('sap_inj_recent_events', () => 'sap_inj_recent_events:' + renderPackets().split('\n\nsap_inj_recent_events:')[1], { description: 'Sage Phase 1 rendered recent events packet preview' });
        } else if (context.registerMacro) {
            context.registerMacro('sap_inj_scene', () => renderPackets().split('\n\nsap_inj_recent_events:')[0]);
            context.registerMacro('sap_inj_recent_events', () => 'sap_inj_recent_events:' + renderPackets().split('\n\nsap_inj_recent_events:')[1]);
        }
    } catch (error) {
        console.warn(`[${MODULE_TITLE}] Macro registration failed.`, error);
    }
}

jQuery(async () => {
    settings();
    metadata();
    installUi();
    installEventHooks();
    installMacros();
    updateUiStatus('ok', 'Loaded. Enable to start extraction.');
});

export async function onActivate() {
    logDebug('Activated.');
}
