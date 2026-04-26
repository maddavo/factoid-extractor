// Sage Phase 1 Factoid Extractor for SillyTavern
// v0.1.13 — ordered pending queue and stale scene-update guard.

const EXTENSION_VERSION = '0.1.13';

const MODULE_NAME = 'sage_phase1_factoid_extractor';
const MODULE_TITLE = 'Sage Phase 1 Factoid Extractor';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    autoRun: true,
    trigger: 'assistant', // assistant | user_and_assistant
    autoRunPolicy: 'periodic_or_scene_cue', // always | periodic_only | periodic_or_marker | periodic_or_scene_cue
    periodicUserMessages: 10,
    sceneCuePrefilter: true,
    sceneMarkerRegex: '<!--SAP_SCENE_CHANGE-->|<sap_scene_change\\s*/?>|\\[\\[SAP_SCENE_CHANGE\\]\\]',
    endpoint: '/proxy/http://127.0.0.1:1234/v1/chat/completions',
    model: 'local-model',
    apiKey: '',
    temperature: 0,
    maxTokens: 1200,
    recentMessageLimit: 10,
    debounceMs: 1500,
    responseFormatJson: false,
    autoApply: false,
    keepResolvedEvents: false,
    unresolvedEventLimit: 6,
    strictRecentEvents: true,
    minEventImportance: 4,
    maxEventsPerProposal: 1,
    clearRoomObjectsOnLocationChange: true,
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
- only rare, temporary, unresolved practical reminders that Sage must remember in the next several turns
- use RecentEvents only when there is a clear consequence not already captured by CurrentScene
- examples that usually qualify: object broken and still matters, important item lost and not found, explicit promise/request/task/deadline, urgent interruption, a plan changed with unresolved next action, factual reminder that must affect the next response
- examples that usually do NOT qualify: ordinary dialogue progress, greetings, banter, flirtation, emotional colour, a normal question/answer, a minor observation, scene transition already stored in CurrentScene, object placement/movement already stored in CurrentScene, person entered/left already reflected in present_entities, completed handover with no unresolved consequence

STRICT RULES:
- Prefer no update over guessing.
- Extract only explicit or strongly established facts.
- Do not infer hidden motives.
- Do not invent.
- Preserve actor/object names.
- For nearby_objects_remove, output only the object name as a string, never an object.
- Avoid pronouns in stored facts.
- Do not store mood as a scene fact.
- Do not store generic flirt lines, banter, emotional colour, ordinary replies, questions, acknowledgements, or decorative ambience as RecentEvents.
- Do not turn every response into a RecentEvent. RecentEvents should be rare.
- Do not duplicate CurrentScene in RecentEvents. If the scene/object state already captures the change, leave recent_event_updates empty unless there is a still-unresolved practical consequence.
- A RecentEvent must pass this gate: would omitting it likely cause Sage to contradict an unresolved task, obligation, broken/lost item, urgent interruption, or changed plan within the next 5-10 turns? If no, do not extract it.
- For RecentEvents, importance_score uses 0-5. Output only importance_score 4 or 5 events.
- Output at most one new RecentEvent per extraction pass. If several candidates exist, keep only the most practically urgent one.
- Do not treat decorative assistant narration as authoritative when it invents unsupported details.
- If assistant narration changes a practical state, include it only when the fact is clear and consistent with prior established context.
- If the current location/room changes, remove old room-local nearby_objects unless the object is explicitly carried into the new scene.
- If new explicit text contradicts old state, prefer the latest explicit fact and include a rejected_candidate or uncertainty note.
- Cap output to the most important Phase 1 facts. Sparse is better than complete.
- If only ordinary conversation happened, set recent_event_updates to [] and explain rejected candidates if useful.
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
For RecentEvents, causal_result is mandatory: describe the unresolved practical consequence. If no unresolved practical consequence exists, do not create the event.
Evidence must point to source turn numbers or short quotes from the chat text.

CRITICAL JSON RELIABILITY RULES:
- Always include all five top-level keys: scene_update, recent_event_updates, resolved_event_updates, rejected_candidates, no_update_reason.
- If there are no events, still output "recent_event_updates": [] and "resolved_event_updates": [].
- End with a complete closing brace.
- Do not leave a dangling comma after scene_update.`;

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
        version: EXTENSION_VERSION,
        currentScene: structuredCloneSafe(EMPTY_SCENE),
        recentEvents: [],
        pendingProposals: [],
        auditLog: [],
        lastProcessedSignature: '',
        lastExtractionUserMessageCount: 0,
        skippedRuns: 0,
        lastSkipReason: '',
        lastRunAt: null,
        lastError: '',
        lastRawExtractorText: ''
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
    if (!m.version) m.version = EXTENSION_VERSION;
    if (m.lastExtractionUserMessageCount === undefined) m.lastExtractionUserMessageCount = 0;
    if (m.skippedRuns === undefined) m.skippedRuns = 0;
    if (m.lastSkipReason === undefined) m.lastSkipReason = '';
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
    if (text === null || text === undefined) return '';
    if (typeof text === 'object') return sanitizeObjectText(text);
    return String(text)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function sanitizeObjectText(value) {
    if (!value || typeof value !== 'object') return '';
    const candidate = value.name ?? value.object ?? value.object_name ?? value.item ?? value.label ?? value.summary ?? value.text ?? '';
    if (candidate) return sanitizeText(candidate);
    try { return JSON.stringify(value); } catch { return ''; }
}

function objectRemoveName(value) {
    if (typeof value === 'string') return sanitizeText(value);
    if (!value || typeof value !== 'object') return '';
    return sanitizeText(value.name ?? value.object ?? value.object_name ?? value.item ?? value.label ?? value.target ?? value.current_name ?? '');
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

function userMessageCount() {
    const chat = ctx().chat || [];
    return chat.filter(message => roleOfMessage(message) === 'user').length;
}

function recentChatText(limit = 6) {
    const chat = ctx().chat || [];
    return chat.slice(Math.max(0, chat.length - limit)).map(message => sanitizeText(message?.mes)).join('\n');
}

function sceneMarkerDetected() {
    const pattern = settings().sceneMarkerRegex || DEFAULT_SETTINGS.sceneMarkerRegex;
    if (!pattern) return false;
    try {
        return new RegExp(pattern, 'i').test(recentChatText(8));
    } catch (error) {
        console.warn('[' + MODULE_TITLE + '] Invalid scene marker regex.', error);
        return false;
    }
}

function deterministicSceneCueDetected() {
    const text = recentChatText(6).toLowerCase();
    if (!text) return false;

    const movementCue = /\b(go(?:es|ing)? to|went to|walks? into|walks? out|runs? to|runs? into|leaves?|exits?|enters?|arrives?|returns?|back at|back in|back to|knocks? on|opens? the door|closes? the door|steps? into|heads? to|moves? to)\b/i;
    const locationCue = /\b(cafeteria|dorm|dorm room|hallway|classroom|chemistry|room|entrance|doorway|outside|inside|table|kitchen|study|bedroom|bathroom|office|garage|car|street|yard|beach|bar|library)\b/i;

    return movementCue.test(text) && locationCue.test(text);
}

function autoRunGate(reason) {
    const s = settings();
    const m = metadata();
    if (reason === 'manual') return { run: true, reason: 'manual run' };

    const policy = s.autoRunPolicy || 'periodic_or_scene_cue';
    if (policy === 'always') return { run: true, reason: 'policy: always' };

    const currentUserCount = userMessageCount();
    const interval = Math.max(1, Number(s.periodicUserMessages || 10));
    const sinceLast = currentUserCount - Number(m.lastExtractionUserMessageCount || 0);
    const periodicDue = sinceLast >= interval;
    const marker = sceneMarkerDetected();
    const cue = Boolean(s.sceneCuePrefilter) && deterministicSceneCueDetected();
    const intervalReached = 'periodic interval reached (' + sinceLast + '/' + interval + ' user messages)';
    const intervalNotReached = 'periodic interval not reached (' + sinceLast + '/' + interval + ' user messages)';

    if (policy === 'periodic_only') {
        return periodicDue ? { run: true, reason: intervalReached } : { run: false, reason: intervalNotReached };
    }

    if (policy === 'periodic_or_marker') {
        if (marker) return { run: true, reason: 'scene marker detected' };
        if (periodicDue) return { run: true, reason: intervalReached };
        return { run: false, reason: 'no scene marker and ' + intervalNotReached };
    }

    if (marker) return { run: true, reason: 'scene marker detected' };
    if (cue) return { run: true, reason: 'deterministic scene cue detected' };
    if (periodicDue) return { run: true, reason: intervalReached };
    return { run: false, reason: 'no scene cue/marker and ' + intervalNotReached };
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

let lastRawExtractorContent = "";

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
    lastRawExtractorContent = String(content || '');
    if (!content) throw new Error('Extractor returned no content.');
    return parseJsonContent(content);
}

function parseJsonContent(content) {
    let text = stripJsonFences(String(content || '').trim());
    const candidates = [];
    if (text) candidates.push(text);

    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

    const errors = [];
    for (const candidate of candidates) {
        try { return JSON.parse(candidate); } catch (error) { errors.push(error?.message || String(error)); }
        const repaired = repairNearJson(candidate);
        if (repaired !== candidate) {
            try { return JSON.parse(repaired); } catch (error) { errors.push(error?.message || String(error)); }
        }
        const completed = completeTruncatedRootJson(repaired);
        if (completed !== repaired) {
            try { return JSON.parse(completed); } catch (error) { errors.push(error?.message || String(error)); }
        }
    }

    const salvaged = salvagePartialProposal(text);
    if (salvaged) return salvaged;

    const detail = errors.length ? ` Parser details: ${errors[errors.length - 1]}` : '';
    throw new Error(`Could not parse extractor JSON.${detail} Raw: ${text.slice(0, 1000)}`);
}

function stripJsonFences(text) {
    return String(text || '')
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
}

function repairNearJson(text) {
    let s = stripJsonFences(text);
    s = s.replace(/^\uFEFF/, '');
    // Remove common JavaScript-style comments outside strict JSON. This is intentionally simple and only used after strict parse fails.
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    s = s.replace(/(^|\s)\/\/.*$/gm, '$1');
    // LM Studio/local models often emit trailing commas, which cause: "Expected double-quoted property name".
    s = s.replace(/,\s*([}\]])/g, '$1');
    // Tolerate a dangling comma at EOF from incomplete top-level output.
    s = s.replace(/,\s*$/g, '');
    // Tolerate bare object keys from near-JSON, e.g. {scene_update: {...}}.
    s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_\-]*)\s*:/g, '$1"$2":');
    // Tolerate Python-ish constants occasionally emitted by local models.
    s = s.replace(/:\s*None\b/g, ': null').replace(/:\s*True\b/g, ': true').replace(/:\s*False\b/g, ': false');
    return s.trim();
}

function completeTruncatedRootJson(text) {
    let s = stripJsonFences(text || '').trim();
    if (!s.startsWith('{')) return s;
    // If the model emitted only {"scene_update": {...}, add the missing empty top-level fields.
    if (/"scene_update"\s*:/.test(s) && !/"recent_event_updates"\s*:/.test(s)) {
        s = s.replace(/,\s*$/g, '');
        s += ',"recent_event_updates":[],"resolved_event_updates":[],"rejected_candidates":[],"no_update_reason":""}';
        return repairNearJson(s);
    }
    return s;
}

function salvagePartialProposal(text) {
    const scene = extractJsonValueForKey(text, 'scene_update');
    if (!scene) return null;
    let sceneObj = null;
    try { sceneObj = JSON.parse(repairNearJson(scene)); } catch { return null; }
    return {
        scene_update: sceneObj,
        recent_event_updates: [],
        resolved_event_updates: [],
        rejected_candidates: [
            {
                candidate: 'Extractor returned incomplete top-level JSON after scene_update.',
                reason: 'Recovered complete scene_update and treated missing RecentEvents fields as empty.'
            }
        ],
        no_update_reason: ''
    };
}

function extractJsonValueForKey(text, key) {
    const src = repairNearJson(text || '');
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('"' + escapedKey + '"\\s*:\\s*');
    const m = re.exec(src);
    if (!m) return null;
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const open = src[i];
    const close = open === '{' ? '}' : open === '[' ? ']' : null;
    if (!close) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < src.length; j++) {
        const ch = src[j];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) return src.slice(i, j + 1);
        }
    }
    return null;
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

    if (settings().strictRecentEvents) {
        const keptEvents = [];
        const rejectedEventCandidates = [];
        const minImportance = Number(settings().minEventImportance || 4);
        const maxEvents = Math.max(0, Number(settings().maxEventsPerProposal || 1));
        for (const ev of normalized.recent_event_updates) {
            const gate = eventGateReason(ev, minImportance, normalized.scene_update);
            if (gate) {
                rejectedEventCandidates.push({
                    candidate: ev.summary || ev.causal_result || '(recent event candidate)',
                    reason: gate
                });
            } else {
                keptEvents.push(ev);
            }
        }
        keptEvents.sort((a, b) => Number(b.importance_score || 0) - Number(a.importance_score || 0));
        const allowed = keptEvents.slice(0, maxEvents);
        for (const ev of keptEvents.slice(maxEvents)) {
            rejectedEventCandidates.push({
                candidate: ev.summary || ev.causal_result || '(recent event candidate)',
                reason: `Dropped by sparse event cap: max ${maxEvents} new RecentEvent(s) per extraction.`
            });
        }
        normalized.recent_event_updates = allowed;
        normalized.rejected_candidates.push(...rejectedEventCandidates);
    }

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

    normalized.scene_update.nearby_objects_remove = normalized.scene_update.nearby_objects_remove
        .map(objectRemoveName)
        .filter(Boolean);
    normalized.scene_update.present_entities_add = normalized.scene_update.present_entities_add.map(sanitizeText).filter(Boolean);
    normalized.scene_update.present_entities_remove = normalized.scene_update.present_entities_remove.map(sanitizeText).filter(Boolean);
    if (normalized.scene_update.location_ref !== null) normalized.scene_update.location_ref = sanitizeText(normalized.scene_update.location_ref);
    if (normalized.scene_update.surroundings_summary !== null) normalized.scene_update.surroundings_summary = sanitizeText(normalized.scene_update.surroundings_summary);

    return normalized;
}

function eventGateReason(event, minImportance, sceneUpdate = null) {
    const summary = sanitizeText(event?.summary);
    const result = sanitizeText(event?.causal_result);
    const evidence = sanitizeText(event?.evidence);
    const score = Number(event?.importance_score || 0);
    if (!summary) return 'Dropped RecentEvent candidate: missing summary.';
    if (!result) return 'Dropped RecentEvent candidate: no unresolved practical causal result.';
    if (!evidence) return 'Dropped RecentEvent candidate: no source evidence.';
    if (score < minImportance) return `Dropped RecentEvent candidate: importance ${score} below strict threshold ${minImportance}.`;

    const combined = `${summary} ${result}`.toLowerCase();

    const unresolvedPracticalPatterns = [
        /\b(broke|broken|breaks|damaged|damage|lost|missing|can't find|cannot find|not found|hid|hidden|stolen)\b/,
        /\b(promised|promise|agreed to|agreement|asked .* to|requested|request|task|deadline|urgent|must|needs to|need to|has to|still needs)\b/,
        /\b(plan changed|change of plan|new plan|remind|remember|waiting for|depends on|blocked|can't continue|cannot continue|owe|owed|due)\b/,
        /\b(interrupted by|alarm|phone call|knock at the door|emergency)\b/
    ];
    const hasUnresolvedPracticalCue = unresolvedPracticalPatterns.some(re => re.test(combined));
    if (!hasUnresolvedPracticalCue) {
        return 'Dropped RecentEvent candidate: no clear unresolved task/problem/changed-plan consequence beyond CurrentScene.';
    }

    if (sceneUpdate && eventDuplicatesSceneDelta(event, sceneUpdate)) {
        return 'Dropped RecentEvent candidate: already captured by CurrentScene/object state.';
    }

    return '';
}

function eventDuplicatesSceneDelta(event, sceneUpdate) {
    const combined = `${event?.summary || ''} ${event?.causal_result || ''}`.toLowerCase();
    const objectUpdates = Array.isArray(sceneUpdate?.nearby_objects_add_or_update) ? sceneUpdate.nearby_objects_add_or_update : [];
    const objectRemoves = Array.isArray(sceneUpdate?.nearby_objects_remove) ? sceneUpdate.nearby_objects_remove.map(objectRemoveName) : [];
    for (const obj of objectUpdates) {
        const name = sanitizeText(obj?.name).toLowerCase();
        if (name && combined.includes(name)) return true;
    }
    for (const nameRaw of objectRemoves) {
        const name = sanitizeText(nameRaw).toLowerCase();
        if (name && combined.includes(name)) return true;
    }
    if (sceneUpdate?.location_ref && /\b(location|setting|scene|arrives?|returns?|leaves?|enters?)\b/.test(combined)) return true;
    if ((sceneUpdate?.present_entities_add?.length || sceneUpdate?.present_entities_remove?.length) && /\b(arrives?|returns?|leaves?|enters?|present|alone)\b/.test(combined)) return true;
    return false;
}

function eventRenderable(event) {
    if (!event || event.resolved) return false;
    if (!settings().strictRecentEvents) return true;
    return !eventGateReason(event, Number(settings().minEventImportance || 4), null);
}

function pruneStoredRecentEvents() {
    const m = metadata();
    const before = (m.recentEvents || []).length;
    m.recentEvents = (m.recentEvents || []).filter(eventRenderable);
    const maxEvents = Math.max(1, Number(settings().unresolvedEventLimit || 6));
    m.recentEvents = m.recentEvents.slice(0, maxEvents);
    saveMetadataNow();
    updatePanel();
    toastInfo(`Pruned ${before - m.recentEvents.length} stored RecentEvent(s).`);
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

    if (reason !== 'manual') {
        const gate = autoRunGate(reason);
        if (!gate.run) {
            m.skippedRuns = Number(m.skippedRuns || 0) + 1;
            m.lastSkipReason = gate.reason;
            await saveMetadataNow();
            updatePanel();
            updateUiStatus('ok', 'Auto-run skipped: ' + gate.reason);
            logDebug('Auto-run skipped.', gate.reason);
            return;
        }
        reason = reason + '; ' + gate.reason;
    }

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
        m.lastExtractionUserMessageCount = userMessageCount();
        m.lastSkipReason = '';
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
        metadata().lastRawExtractorText = lastRawExtractorContent || '';
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
    const oldLocation = scene.location_ref || '';
    const newLocation = su.location_ref || '';
    const locationChanged = Boolean(newLocation && oldLocation && !sameText(oldLocation, newLocation));
    const staleSceneProposal = Number(scene.last_updated_turn || 0) > 0 && Number(turn || 0) < Number(scene.last_updated_turn || 0);

    scene.nearby_objects = Array.isArray(scene.nearby_objects) ? scene.nearby_objects : [];
    if (staleSceneProposal) {
        proposal.stale_scene_update_skipped = `Proposal turn ${turn} is older than applied scene turn ${scene.last_updated_turn}; scene/location/surroundings/object changes were not applied.`;
        const copied = structuredCloneSafe(delta);
        copied.scene_update = {
            location_ref: null,
            present_entities_add: [],
            present_entities_remove: [],
            nearby_objects_add_or_update: [],
            nearby_objects_remove: [],
            surroundings_summary: null
        };
        copied.rejected_candidates = [
            ...(copied.rejected_candidates || []),
            { candidate: 'Stale scene update', reason: proposal.stale_scene_update_skipped }
        ];
        proposal.delta = copied;
    }

    const effectiveDelta = proposal.delta || delta;
    const effectiveSceneUpdate = effectiveDelta.scene_update || {};

    if (!staleSceneProposal && settings().clearRoomObjectsOnLocationChange && locationChanged) {
        const staleBefore = staleObjectsForSceneChange(effectiveSceneUpdate);
        const keepNames = new Set((effectiveSceneUpdate.nearby_objects_add_or_update || [])
            .map(o => canonicalKey(o?.name))
            .filter(Boolean));
        scene.nearby_objects = scene.nearby_objects.filter(o => keepNames.has(canonicalKey(o?.name)));
        proposal.auto_expired_objects = staleBefore.map(o => ({
            name: o.name,
            location: o.location,
            scene_ref: o.scene_ref || oldLocation,
            reason: `Location changed from ${oldLocation} to ${newLocation}`
        }));
    }

    if (effectiveSceneUpdate.location_ref) scene.location_ref = effectiveSceneUpdate.location_ref;
    if (effectiveSceneUpdate.surroundings_summary) scene.surroundings_summary = effectiveSceneUpdate.surroundings_summary;

    for (const ent of effectiveSceneUpdate.present_entities_add || []) addUnique(scene.present_entities, ent);
    for (const ent of effectiveSceneUpdate.present_entities_remove || []) removeByCaseInsensitive(scene.present_entities, ent);

    for (const removeName of effectiveSceneUpdate.nearby_objects_remove || []) {
        scene.nearby_objects = scene.nearby_objects.filter(o => !sameText(o.name, removeName));
    }
    for (const obj of effectiveSceneUpdate.nearby_objects_add_or_update || []) {
        if (!obj.name || !obj.location) continue;
        const existing = scene.nearby_objects.find(o => sameText(o.name, obj.name));
        if (existing) {
            existing.location = obj.location;
            existing.scene_ref = scene.location_ref || existing.scene_ref || '';
            existing.evidence = obj.evidence || existing.evidence || '';
            existing.last_updated_turn = turn;
        } else {
            scene.nearby_objects.push({
                name: obj.name,
                location: obj.location,
                scene_ref: scene.location_ref || '',
                evidence: obj.evidence || '',
                last_updated_turn: turn
            });
        }
    }

    if (!staleSceneProposal && hasSubstantiveDelta(effectiveDelta)) scene.last_updated_turn = turn;
    m.currentScene = scene;

    for (const event of effectiveDelta.recent_event_updates || []) {
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

    for (const res of effectiveDelta.resolved_event_updates || []) {
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
        m.recentEvents = m.recentEvents.filter(eventRenderable).slice(0, maxEvents);
    } else if (settings().strictRecentEvents) {
        m.recentEvents = m.recentEvents.filter(e => e.resolved || eventRenderable(e)).slice(0, Math.max(maxEvents, 12));
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

function groupObjectsByLocation(objects) {
    const groups = [];
    const indexByLocation = new Map();
    for (const obj of objects || []) {
        const name = sanitizeText(obj?.name);
        const location = displayLocationForObject(obj?.location, obj?.scene_ref);
        if (!name || !location) continue;
        const key = location.toLowerCase();
        let group = indexByLocation.get(key);
        if (!group) {
            group = { location, names: [] };
            indexByLocation.set(key, group);
            groups.push(group);
        }
        if (!group.names.some(existing => sameText(existing, name))) group.names.push(name);
    }
    return groups;
}

function groupedObjectLines(objects) {
    return groupObjectsByLocation(objects).map(group => `${group.location}: ${group.names.join(', ')}`);
}

function findCurrentObjectLocation(objectName) {
    const scene = metadata().currentScene || EMPTY_SCENE;
    const found = (scene.nearby_objects || []).find(o => sameText(o?.name, objectName));
    return found?.location || '';
}

function canonicalKey(value) {
    return String(value || '').trim().toLowerCase();
}

function sceneLocationWillChange(sceneUpdate) {
    const current = sanitizeText(metadata().currentScene?.location_ref);
    const next = sanitizeText(sceneUpdate?.location_ref);
    return Boolean(current && next && !sameText(current, next));
}

function staleObjectsForSceneChange(sceneUpdate) {
    if (!settings().clearRoomObjectsOnLocationChange || !sceneLocationWillChange(sceneUpdate)) return [];
    const currentObjects = metadata().currentScene?.nearby_objects || [];
    const explicitKeep = new Set((sceneUpdate?.nearby_objects_add_or_update || [])
        .map(o => canonicalKey(o?.name))
        .filter(Boolean));
    const explicitRemove = new Set((sceneUpdate?.nearby_objects_remove || [])
        .map(objectRemoveName)
        .map(canonicalKey)
        .filter(Boolean));
    return currentObjects.filter(o => {
        const nameKey = canonicalKey(o?.name);
        if (!nameKey) return false;
        if (explicitKeep.has(nameKey)) return false;
        if (explicitRemove.has(nameKey)) return false;
        return true;
    });
}

function displayLocationForObject(location, sceneRef = '') {
    const loc = sanitizeText(location);
    const scene = sanitizeText(sceneRef || metadata().currentScene?.location_ref);
    if (!loc) return '';
    const text = loc.trim();
    const hasExplicitPlace = /\b(cafeteria|dorm|bathroom|hallway|kitchen|bedroom|office|study|room|entrance)\b/i.test(text);
    const genericLocal = /^(the\s+)?(floor|ground|desk|table|chair|bed|door|doorway|door frame|counter|bench)$/i.test(text)
        || /^(on|under|beside|near|next to|against|by)\b/i.test(text)
        || (/\b(floor|desk|table|chair|bed|door frame|counter|bench)\b/i.test(text) && !hasExplicitPlace);
    if (scene && genericLocal && !text.toLowerCase().includes(scene.toLowerCase())) {
        return `${scene} — ${text}`;
    }
    return text;
}

function renderPackets() {
    const m = metadata();
    const scene = m.currentScene || EMPTY_SCENE;
    const sceneLines = [];
    if (scene.location_ref) sceneLines.push(`Current location: ${scene.location_ref}`);
    if (scene.present_entities?.length) sceneLines.push(`Present entities: ${scene.present_entities.join(', ')}`);
    sceneLines.push(...groupedObjectLines(scene.nearby_objects));
    if (scene.surroundings_summary) sceneLines.push(`Surroundings: ${scene.surroundings_summary}`);

    const eventLines = (m.recentEvents || [])
        .filter(eventRenderable)
        .slice(0, Number(settings().unresolvedEventLimit || 6))
        .map(e => e.causal_result ? `${e.summary}; result: ${e.causal_result}` : e.summary);

    const scenePacket = ['sap_inj_scene:', '[OOC scene facts:', ...sceneLines.map(x => `- ${x}`), ']'].join('\n');
    const eventPacket = ['sap_inj_recent_events:', '[OOC recent facts:', ...eventLines.map(x => `- ${x}`), ']'].join('\n');
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
    lines.push(`Review order: ${proposal.status === 'pending' ? 'next pending proposal (oldest first)' : 'not pending / audit view'}`);
    lines.push(`Reason: ${proposal.reason || 'unknown'}`);
    lines.push(`Turn count: ${proposal.turn_count ?? 'unknown'}`);
    if (proposal.stale_scene_update_skipped) lines.push(`Stale scene update skipped: ${proposal.stale_scene_update_skipped}`);
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
        const staleObjects = staleObjectsForSceneChange(su);
        for (const stale of staleObjects) {
            const oldLoc = displayLocationForObject(stale.location, stale.scene_ref || metadata().currentScene?.location_ref);
            lines.push(oldLoc ? `- AUTO-REMOVE previous scene object: ${oldLoc}: ${stale.name}` : `- AUTO-REMOVE previous scene object: ${stale.name}`);
            sceneCount++;
        }
    }
    for (const ent of su.present_entities_add || []) {
        lines.push(`- ADD Present entity: ${ent}`);
        sceneCount++;
    }
    for (const ent of su.present_entities_remove || []) {
        lines.push(`- REMOVE Present entity: ${ent}`);
        sceneCount++;
    }
    const objectUpdateGroups = groupObjectsByLocation(su.nearby_objects_add_or_update || []);
    for (const group of objectUpdateGroups) {
        lines.push(`- ADD/UPDATE ${group.location}: ${group.names.join(', ')}`);
        const evidence = (su.nearby_objects_add_or_update || [])
            .filter(o => sameText(o?.location, group.location) && o?.evidence)
            .map(o => sanitizeText(o.evidence))
            .filter(Boolean)[0];
        if (evidence) lines.push(`  Evidence: ${evidence}`);
        sceneCount++;
    }
    for (const objName of su.nearby_objects_remove || []) {
        const currentLocation = displayLocationForObject(findCurrentObjectLocation(objName));
        lines.push(currentLocation ? `- REMOVE ${currentLocation}: ${objName}` : `- REMOVE Object/location: ${objName}`);
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
        lines.push(`- ADD Recent event: ${summary}${result} [importance ${Number(ev.importance_score || 0)}]`);
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

function pendingProposalsOrdered() {
    const pending = (metadata().pendingProposals || []).filter(p => p.status === 'pending');
    return pending.slice().sort((a, b) => {
        const ta = Number(a.turn_count || 0);
        const tb = Number(b.turn_count || 0);
        if (ta !== tb) return ta - tb;
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
}

function reviewProposal() {
    return pendingProposalsOrdered()[0] || (metadata().pendingProposals || [])[0] || null;
}

function latestProposal() {
    return reviewProposal();
}

function renderPendingQueue() {
    const pending = pendingProposalsOrdered();
    if (!pending.length) return 'No pending proposals.';
    const lines = ['Pending proposal queue (oldest first):'];
    pending.forEach((p, i) => {
        const delta = p.delta || {};
        const su = delta.scene_update || {};
        const parts = [];
        if (su.location_ref) parts.push(`location=${su.location_ref}`);
        if (su.surroundings_summary) parts.push('surroundings');
        if (su.present_entities_add?.length || su.present_entities_remove?.length) parts.push('entities');
        if (su.nearby_objects_add_or_update?.length || su.nearby_objects_remove?.length) parts.push('objects');
        if (delta.recent_event_updates?.length || delta.resolved_event_updates?.length) parts.push('events');
        lines.push(`${i + 1}. Turn ${p.turn_count ?? '?'} | ${p.created_at || ''} | ${parts.join(', ') || 'no substantive fields'} | id ${p.id}`);
    });
    return lines.join('\n');
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

function clearNearbyObjects() {
    if (!confirm('Clear all nearby objects from the current applied scene? Use this to clean stale objects after a scene-change bug.')) return;
    const m = metadata();
    m.currentScene = m.currentScene || structuredCloneSafe(EMPTY_SCENE);
    const count = Array.isArray(m.currentScene.nearby_objects) ? m.currentScene.nearby_objects.length : 0;
    m.currentScene.nearby_objects = [];
    saveMetadataNow();
    updatePanel();
    toastInfo(`Cleared ${count} nearby object(s).`);
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
    setInputValue('sfe_autorun_policy', s.autoRunPolicy);
    setInputValue('sfe_periodic_user_messages', s.periodicUserMessages);
    setInputValue('sfe_scene_cue_prefilter', s.sceneCuePrefilter, 'checked');
    setInputValue('sfe_scene_marker_regex', s.sceneMarkerRegex);
    setInputValue('sfe_json_response', s.responseFormatJson, 'checked');
    setInputValue('sfe_strict_events', s.strictRecentEvents, 'checked');
    setInputValue('sfe_min_event_importance', s.minEventImportance);
    setInputValue('sfe_max_events_per_proposal', s.maxEventsPerProposal);
    setInputValue('sfe_clear_objects_on_location_change', s.clearRoomObjectsOnLocationChange, 'checked');

    const latest = reviewProposal();
    const summaryPre = document.querySelector('#sfe_latest_summary');
    if (summaryPre) summaryPre.textContent = renderProposalSummary(latest);

    const proposalPre = document.querySelector('#sfe_latest_proposal');
    if (proposalPre) proposalPre.textContent = latest ? JSON.stringify(latest, null, 2) : (m.lastRawExtractorText ? `Last raw extractor text from failed parse:
${m.lastRawExtractorText}` : 'No extractor output yet.');

    const queuePre = document.querySelector('#sfe_pending_queue');
    if (queuePre) queuePre.textContent = renderPendingQueue();

    const statePre = document.querySelector('#sfe_state_preview');
    if (statePre) statePre.textContent = JSON.stringify({ currentScene: m.currentScene, recentEvents: m.recentEvents }, null, 2);

    const packetPre = document.querySelector('#sfe_packet_preview');
    if (packetPre) packetPre.textContent = renderPackets();

    const countEl = document.querySelector('#sfe_counts');
    if (countEl) {
        const pending = m.pendingProposals.filter(p => p.status === 'pending').length;
        const next = pendingProposalsOrdered()[0];
        const nextText = next ? ` | next pending turn: ${next.turn_count ?? '?'}` : '';
        countEl.textContent = `Version: v${EXTENSION_VERSION} | Audit runs: ${m.auditLog.length} | pending: ${pending}${nextText} | skipped: ${m.skippedRuns || 0} | last run: ${m.lastRunAt || 'never'} | last skip: ${m.lastSkipReason || 'none'}`;
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
  <h3>Sage Phase 1 Factoid Extractor <span class="sfe-version">v${EXTENSION_VERSION}</span></h3>
  <div class="sfe-small">Live extraction of proposed CurrentScene and RecentEvents deltas. Review-first by default.</div>

  <div class="sfe-row"><label><input id="sfe_enabled" type="checkbox"> Enabled</label><label><input id="sfe_autorun" type="checkbox"> Auto-run</label><label><input id="sfe_autoapply" type="checkbox"> Auto-apply proposed deltas</label><label><input id="sfe_debug" type="checkbox"> Debug console logging</label></div>
  <div class="sfe-row"><label for="sfe_trigger">Trigger</label><select id="sfe_trigger"><option value="assistant">After assistant reply</option><option value="user_and_assistant">After user and assistant messages</option></select></div>
  <div class="sfe-row"><label for="sfe_autorun_policy">Auto-run policy</label><select id="sfe_autorun_policy"><option value="periodic_or_scene_cue">Periodic or scene cue</option><option value="periodic_or_marker">Periodic or explicit marker only</option><option value="periodic_only">Periodic only</option><option value="always">Always run on trigger</option></select><label for="sfe_periodic_user_messages">Every N user messages</label><input id="sfe_periodic_user_messages" type="number" min="1" max="50" step="1"><label><input id="sfe_scene_cue_prefilter" type="checkbox"> Scene cue prefilter</label></div>
  <div class="sfe-row"><label for="sfe_scene_marker_regex">Scene marker regex</label><input id="sfe_scene_marker_regex" type="text" spellcheck="false"></div>
  <div class="sfe-row"><label for="sfe_endpoint">Extractor endpoint</label><input id="sfe_endpoint" type="text" spellcheck="false"></div>
  <div class="sfe-row"><label for="sfe_model">Model</label><input id="sfe_model" type="text" spellcheck="false"></div>
  <div class="sfe-row"><label for="sfe_apikey">API key</label><input id="sfe_apikey" type="text" spellcheck="false" placeholder="blank for LM Studio"></div>
  <div class="sfe-row"><label for="sfe_recent_limit">Recent messages</label><input id="sfe_recent_limit" type="number" min="2" max="40" step="1"><label for="sfe_max_tokens">Max output tokens</label><input id="sfe_max_tokens" type="number" min="100" max="4000" step="50"><label><input id="sfe_json_response" type="checkbox"> Request JSON response_format</label></div>
  <div class="sfe-row"><label><input id="sfe_strict_events" type="checkbox"> Strict RecentEvents gate</label><label for="sfe_min_event_importance">Min event importance</label><input id="sfe_min_event_importance" type="number" min="0" max="5" step="1"><label for="sfe_max_events_per_proposal">Max events/proposal</label><input id="sfe_max_events_per_proposal" type="number" min="0" max="3" step="1"></div>
  <div class="sfe-row"><label><input id="sfe_clear_objects_on_location_change" type="checkbox"> Expire old room objects on location change</label><span class="sfe-small">Recommended on: prevents “The floor” objects from following Sage into a new room.</span></div>

  <div class="sfe-row sfe-buttons">
    <button id="sfe_run_now" class="menu_button">Run extraction now</button>
    <button id="sfe_apply_latest" class="menu_button">Apply next pending</button>
    <button id="sfe_reject_latest" class="menu_button">Reject next pending</button>
    <button id="sfe_copy_summary" class="menu_button">Copy review summary</button>
    <button id="sfe_copy_latest" class="menu_button">Copy latest JSON</button>
    <button id="sfe_copy_packets" class="menu_button">Copy OOC packet preview</button>
    <button id="sfe_prune_events" class="menu_button">Prune weak RecentEvents</button>
    <button id="sfe_clear_objects" class="menu_button">Clear nearby objects</button>
    <button id="sfe_export_json" class="menu_button">Export audit JSON</button>
    <button id="sfe_export_md" class="menu_button">Export controller MD</button>
    <button id="sfe_reset" class="menu_button">Reset chat state</button>
  </div>

  <div id="sfe_status" class="sfe-status-warn">Idle.</div>
  <div id="sfe_counts" class="sfe-small"></div>

  <details open><summary>Next pending proposed packet changes</summary><pre id="sfe_latest_summary"></pre></details>
  <details open><summary>Pending proposal queue</summary><pre id="sfe_pending_queue"></pre></details>
  <details><summary>Raw selected/next extractor JSON</summary><pre id="sfe_latest_proposal"></pre></details>
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
    bindSetting('sfe_autorun_policy', 'autoRunPolicy');
    bindSetting('sfe_periodic_user_messages', 'periodicUserMessages', 'number');
    bindSetting('sfe_scene_cue_prefilter', 'sceneCuePrefilter', 'boolean');
    bindSetting('sfe_scene_marker_regex', 'sceneMarkerRegex');
    bindSetting('sfe_json_response', 'responseFormatJson', 'boolean');
    bindSetting('sfe_strict_events', 'strictRecentEvents', 'boolean');
    bindSetting('sfe_min_event_importance', 'minEventImportance', 'number');
    bindSetting('sfe_max_events_per_proposal', 'maxEventsPerProposal', 'number');
    bindSetting('sfe_clear_objects_on_location_change', 'clearRoomObjectsOnLocationChange', 'boolean');

    document.getElementById('sfe_run_now')?.addEventListener('click', () => runExtraction('manual'));
    document.getElementById('sfe_apply_latest')?.addEventListener('click', async () => {
        const p = pendingProposalsOrdered()[0];
        if (!p) return toastWarn('No pending substantive proposal.');
        applyProposalById(p.id);
        await saveMetadataNow();
        updatePanel();
        toastInfo('Next pending proposal applied.');
    });
    document.getElementById('sfe_reject_latest')?.addEventListener('click', async () => {
        const p = pendingProposalsOrdered()[0];
        if (!p) return toastWarn('No pending substantive proposal.');
        rejectProposalById(p.id);
        await saveMetadataNow();
        updatePanel();
        toastInfo('Next pending proposal rejected.');
    });
    document.getElementById('sfe_copy_summary')?.addEventListener('click', () => copyToClipboard(renderProposalSummary(latestProposal())));
    document.getElementById('sfe_copy_latest')?.addEventListener('click', () => copyToClipboard(JSON.stringify(latestProposal() || {}, null, 2)));
    document.getElementById('sfe_copy_packets')?.addEventListener('click', () => copyToClipboard(renderPackets()));
    document.getElementById('sfe_prune_events')?.addEventListener('click', () => pruneStoredRecentEvents());
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
