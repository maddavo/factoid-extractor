// Sage Phase 1 Factoid Extractor for SillyTavern
// v0.1.24 — split source modules.

import { EXTENSION_VERSION, MODULE_NAME, MODULE_TITLE, DEFAULT_SETTINGS, EMPTY_SCENE } from './constants.js';
import { EXTRACTION_SYSTEM_PROMPT } from './prompt.js';
import { buildLmStudioJsonSchemaResponseFormat } from './schema.js';
import { parseJsonContent } from './json-repair.js';
import { ctx, settings, saveSettings, defaultMetadata, metadata, saveMetadataNow, structuredCloneSafe, logDebug, toastInfo, toastWarn, toastError, sanitizeText, objectRemoveName, getRecentTurns, chatSignature, userMessageCount, recentChatText, addUnique, removeByCaseInsensitive, sameText } from './state.js';
import { coalesceNearbyObjects, coalesceSceneUpdateObjects, coalesceRecentEvents, normalizeProposal, isSplitSceneState, filterNoOpSceneDelta, eventGateReason, eventDuplicatesSceneDelta, eventRenderable, hasSubstantiveDelta, reconcileSceneObjectsForStorage } from './reconcile.js';

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
    const locationCue = /\b(cafeteria|dorm|dorm room|hallway|classroom|chemistry|exam hall|exam|room|entrance|doorway|outside|inside|table|kitchen|hots kitchen|study|bedroom|bathroom|office|garage|car|street|yard|beach|bar|library)\b/i;

    return movementCue.test(text) && locationCue.test(text);
}

function highSalienceEventCueDetected() {
    if (!settings().highSalienceEventCuePrefilter) return false;
    const text = recentChatText(10).toLowerCase();
    if (!text) return false;

    const relationshipCue = /\b(girlfriend|boyfriend|partner|relationship|dating|date me|go out with me|be with me|be my|official|couple|master|mistress|dominant|submissive|dom\b|sub\b|owner|owned by|belong to|belongs to|claim me|claimed me|collar|collared)\b/i;
    const acceptanceCue = /\b(yes|okay|ok|accepted?|agreed?|i will|i do|of course|let's|we are|we're|i'd like that|i want that)\b/i;
    const commitmentCue = /\b(promised|promise|agreed to|agreement|deal|plan changed|new plan|deadline|urgent|important|remember|remind me|don't forget|owe|waiting for|depends on|blocked|lost|missing|broken|stolen|hidden)\b/i;

    // Relationship terms alone wake the extractor; the extractor still decides whether a true status change occurred.
    if (relationshipCue.test(text)) return true;
    if (commitmentCue.test(text)) return true;
    // Catch short acceptance lines following a recent relationship proposal.
    return acceptanceCue.test(text) && relationshipCue.test(recentChatText(16).toLowerCase());
}


function remoteCommunicationCueDetected() {
    if (!settings().remoteCommunicationCuePrefilter) return false;
    const text = recentChatText(12).toLowerCase();
    if (!text) return false;

    const remoteMode = /\b(texts?|texting|message(?:s|d)?|dm\b|phone|calls?|calling|video call|facetime|sms|reply(?:ing)? by text)\b/i;
    const separation = /\b(left|leaves|went to|goes to|gone to|exam|exam hall|class|classroom|kitchen|hots kitchen|not in the same room|physically separated|remote|away|elsewhere)\b/i;
    return remoteMode.test(text) && separation.test(text);
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
    const eventCue = highSalienceEventCueDetected();
    const remoteCue = remoteCommunicationCueDetected();
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
    if (eventCue) return { run: true, reason: 'high-salience event cue detected' };
    if (remoteCue) return { run: true, reason: 'remote communication/split-scene cue detected' };
    if (periodicDue) return { run: true, reason: intervalReached };
    return { run: false, reason: 'no scene/event/remote cue or marker and ' + intervalNotReached };
}

function truncateExtractorText(text, maxChars) {
    const value = sanitizeText(text);
    const limit = Math.max(120, Number(maxChars || 900));
    if (value.length <= limit) return value;
    return value.slice(0, limit - 24).trimEnd() + ' …[truncated]';
}

function compactRecentEventForPayload(event) {
    return {
        summary: truncateExtractorText(event?.summary, 260),
        causal_result: truncateExtractorText(event?.causal_result, 260),
        resolved: Boolean(event?.resolved),
        importance_score: Number(event?.importance_score || 0),
        evidence: truncateExtractorText(event?.evidence, 180)
    };
}

function buildExtractorPayloadObject(options = {}) {
    const s = settings();
    const m = metadata();
    const compact = Boolean(options.compact);
    const maxTurnChars = compact
        ? Math.max(240, Math.floor(Number(s.maxInputCharsPerTurn || 900) / 2))
        : Math.max(240, Number(s.maxInputCharsPerTurn || 900));
    const recentLimit = compact
        ? Math.max(2, Math.min(Number(s.recentMessageLimit || 6), 3))
        : Number(s.recentMessageLimit || 6);
    const maxPreviousEvents = compact
        ? Math.max(1, Math.min(Number(s.maxPreviousRecentEventsForPayload || 4), 2))
        : Math.max(0, Number(s.maxPreviousRecentEventsForPayload || 4));

    const previousEvents = coalesceRecentEvents(m.recentEvents || [])
        .filter(eventRenderable)
        .slice(0, maxPreviousEvents)
        .map(compactRecentEventForPayload);

    const recentTurns = getRecentTurns(recentLimit).map(turn => ({
        ...turn,
        text: truncateExtractorText(turn.text, maxTurnChars)
    }));

    return {
        task: compact
            ? 'Propose sparse Phase 1 continuity delta. Compact retry after context overflow.'
            : 'Propose Phase 1 continuity state delta from recent SillyTavern chat turns.',
        previous_CurrentScene: m.currentScene,
        previous_RecentEvents: previousEvents,
        recent_chat_turns: recentTurns
    };
}

function buildExtractorUserPayload(options = {}) {
    const s = settings();
    const compact = Boolean(options.compact);
    const maxPayloadChars = Math.max(4000, Number(s.maxExtractorPayloadChars || 14000));
    const payloadObject = buildExtractorPayloadObject(options);
    let payload = JSON.stringify(payloadObject, null, 2);

    while (payload.length > maxPayloadChars && payloadObject.recent_chat_turns.length > 2) {
        payloadObject.recent_chat_turns.shift();
        payload = JSON.stringify(payloadObject, null, 2);
    }

    if (payload.length > maxPayloadChars && !compact) {
        return buildExtractorUserPayload({ compact: true });
    }

    metadata().lastExtractorPayloadChars = payload.length;
    return payload;
}

function isContextExceededError(error) {
    return /context size|context length|maximum context|too many tokens|prompt is too long|exceeded/i.test(String(error?.message || error || ''));
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



function pruneStoredRecentEvents() {
    const m = metadata();
    const before = (m.recentEvents || []).length;
    m.recentEvents = coalesceRecentEvents(m.recentEvents || []).filter(eventRenderable);
    const maxEvents = Math.max(1, Number(settings().unresolvedEventLimit || 6));
    m.recentEvents = m.recentEvents.slice(0, maxEvents);
    saveMetadataNow();
    updatePanel();
    toastInfo(`Pruned ${before - m.recentEvents.length} stored RecentEvent(s).`);
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
        let promptPayload = buildExtractorUserPayload();
        let raw;
        let compactRetryUsed = false;
        try {
            raw = await callExtractor(promptPayload);
        } catch (error) {
            if (!isContextExceededError(error)) throw error;
            compactRetryUsed = true;
            updateUiStatus('running', 'Context exceeded; retrying extractor with compact payload...');
            promptPayload = buildExtractorUserPayload({ compact: true });
            raw = await callExtractor(promptPayload);
        }
        const delta = normalizeProposal(raw);
        const proposal = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            created_at: new Date().toISOString(),
            reason,
            chat_signature: sig,
            turn_count: (ctx().chat || []).length,
            status: hasSubstantiveDelta(delta) ? 'pending' : 'no_update',
            context_retry_used: compactRetryUsed,
            extractor_payload_chars: metadata().lastExtractorPayloadChars || promptPayload.length,
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

    scene.nearby_objects = coalesceNearbyObjects(scene.nearby_objects, scene.location_ref || oldLocation, turn);
    reconcileSceneObjectsForStorage(scene);

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
    m.recentEvents = coalesceRecentEvents(m.recentEvents || []);
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
    if (scene.location_ref) sceneLines.push(`${isSplitSceneState(scene) ? 'Split scene' : 'Current location'}: ${scene.location_ref.replace(/^Split scene:\s*/i, '')}`);
    if (scene.present_entities?.length) sceneLines.push(`${isSplitSceneState(scene) ? 'Entities' : 'Present entities'}: ${scene.present_entities.join(', ')}`);
    sceneLines.push(...groupedObjectLines(scene.nearby_objects));
    if (scene.surroundings_summary) sceneLines.push(`Surroundings: ${scene.surroundings_summary}`);

    const eventLines = coalesceRecentEvents(m.recentEvents || [])
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
    if (proposal.extractor_payload_chars) lines.push(`Extractor payload: ${proposal.extractor_payload_chars} chars${proposal.context_retry_used ? ' (compact retry used)' : ''}`);
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

async function coalesceCurrentObjects() {
    const m = metadata();
    const scene = m.currentScene || structuredCloneSafe(EMPTY_SCENE);
    const before = Array.isArray(scene.nearby_objects) ? scene.nearby_objects.length : 0;
    scene.nearby_objects = coalesceNearbyObjects(scene.nearby_objects || [], scene.location_ref || '', scene.last_updated_turn || 0);
    const after = scene.nearby_objects.length;
    m.currentScene = scene;
    await saveMetadataNow();
    updatePanel();
    toastInfo(`Coalesced nearby objects: ${before} → ${after}.`);
}

async function reconcileCurrentScene() {
    const m = metadata();
    const scene = m.currentScene || structuredCloneSafe(EMPTY_SCENE);
    const before = Array.isArray(scene.nearby_objects) ? scene.nearby_objects.length : 0;
    reconcileSceneObjectsForStorage(scene);
    const after = scene.nearby_objects.length;
    m.currentScene = scene;
    await saveMetadataNow();
    updatePanel();
    toastInfo(`Reconciled scene objects: ${before} → ${after}.`);
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
    setInputValue('sfe_max_input_chars', s.maxInputCharsPerTurn);
    setInputValue('sfe_max_previous_events_payload', s.maxPreviousRecentEventsForPayload);
    setInputValue('sfe_max_payload_chars', s.maxExtractorPayloadChars);
    setInputValue('sfe_trigger', s.trigger);
    setInputValue('sfe_autorun_policy', s.autoRunPolicy);
    setInputValue('sfe_periodic_user_messages', s.periodicUserMessages);
    setInputValue('sfe_scene_cue_prefilter', s.sceneCuePrefilter, 'checked');
    setInputValue('sfe_event_cue_prefilter', s.highSalienceEventCuePrefilter, 'checked');
    setInputValue('sfe_remote_cue_prefilter', s.remoteCommunicationCuePrefilter, 'checked');
    setInputValue('sfe_scene_marker_regex', s.sceneMarkerRegex);
    setInputValue('sfe_json_response', s.responseFormatJson, 'checked');
    setInputValue('sfe_strict_events', s.strictRecentEvents, 'checked');
    setInputValue('sfe_min_event_importance', s.minEventImportance);
    setInputValue('sfe_max_events_per_proposal', s.maxEventsPerProposal);
    setInputValue('sfe_recent_event_coalescing_mode', s.recentEventsCoalescingMode || 'conservative');
    setInputValue('sfe_clear_objects_on_location_change', s.clearRoomObjectsOnLocationChange, 'checked');
    setInputValue('sfe_surroundings_mode', s.surroundingsUpdateMode || 'location_only');
    setInputValue('sfe_object_coalescing_mode', s.objectCoalescingMode || 'conservative');
    setInputValue('sfe_scene_reconciliation_mode', s.sceneReconciliationMode || 'suppress_participant_blocking');

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
        countEl.textContent = `v${EXTENSION_VERSION} | pending ${pending}${nextText} | runs ${m.auditLog.length} | skipped ${m.skippedRuns || 0} | payload ${m.lastExtractorPayloadChars || 0} chars | last run ${m.lastRunAt || 'never'} | last skip ${m.lastSkipReason || 'none'}`;
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
  <div class="sfe-topbar">
    <div>
      <h3>Sage Phase 1 Factoid Extractor <span class="sfe-version">v${EXTENSION_VERSION}</span></h3>
      <div id="sfe_counts" class="sfe-small sfe-counts"></div>
    </div>
    <div class="sfe-topchecks">
      <label><input id="sfe_enabled" type="checkbox"> Enabled</label>
      <label><input id="sfe_autorun" type="checkbox"> Auto-run</label>
    </div>
  </div>

  <div id="sfe_status" class="sfe-status-warn">Idle.</div>

  <details class="sfe-section sfe-operator" open>
    <summary>Operator review</summary>
    <div class="sfe-actionbar">
      <button id="sfe_run_now" class="menu_button">Run now</button>
      <button id="sfe_apply_latest" class="menu_button sfe-primary-action">Apply next</button>
      <button id="sfe_reject_latest" class="menu_button sfe-danger-action">Reject next</button>
      <button id="sfe_copy_summary" class="menu_button">Copy pending</button>
      <button id="sfe_copy_packets" class="menu_button">Copy rendered</button>
    </div>
    <div class="sfe-review-grid">
      <section class="sfe-review-card">
        <div class="sfe-card-title">Next pending proposed packet changes</div>
        <pre id="sfe_latest_summary"></pre>
      </section>
      <section class="sfe-review-card">
        <div class="sfe-card-title">Rendered OOC packet preview</div>
        <pre id="sfe_packet_preview"></pre>
      </section>
    </div>
  </details>

  <details class="sfe-section">
    <summary>Pending queue / diagnostics</summary>
    <div class="sfe-review-grid sfe-diagnostics-grid">
      <section class="sfe-review-card">
        <div class="sfe-card-title">Pending proposal queue</div>
        <pre id="sfe_pending_queue"></pre>
      </section>
      <section class="sfe-review-card">
        <div class="sfe-card-title">Raw selected/next extractor JSON</div>
        <pre id="sfe_latest_proposal"></pre>
      </section>
    </div>
    <details class="sfe-nested-details"><summary>Applied Phase 1 state</summary><pre id="sfe_state_preview"></pre></details>
  </details>

  <details class="sfe-section">
    <summary>Utilities / maintenance</summary>
    <div class="sfe-row sfe-buttons sfe-utility-buttons">
      <button id="sfe_prune_events" class="menu_button">Prune weak RecentEvents</button>
      <button id="sfe_clear_objects" class="menu_button">Clear nearby objects</button>
      <button id="sfe_coalesce_objects" class="menu_button">Coalesce current objects</button>
      <button id="sfe_reconcile_scene" class="menu_button">Reconcile current scene</button>
      <button id="sfe_copy_latest" class="menu_button">Copy latest JSON</button>
      <button id="sfe_export_json" class="menu_button">Export audit JSON</button>
      <button id="sfe_export_md" class="menu_button">Export controller MD</button>
      <button id="sfe_reset" class="menu_button">Reset chat state</button>
    </div>
  </details>

  <details class="sfe-section sfe-config-section">
    <summary>Configuration</summary>
    <div class="sfe-config-grid">
      <fieldset><legend>General</legend>
        <div class="sfe-row"><label><input id="sfe_autoapply" type="checkbox"> Auto-apply proposed deltas</label><label><input id="sfe_debug" type="checkbox"> Debug console logging</label></div>
        <div class="sfe-row"><label for="sfe_trigger">Trigger</label><select id="sfe_trigger"><option value="assistant">After assistant reply</option><option value="user_and_assistant">After user and assistant messages</option></select></div>
        <div class="sfe-row"><label for="sfe_autorun_policy">Auto-run policy</label><select id="sfe_autorun_policy"><option value="periodic_or_scene_cue">Periodic or scene/event cue</option><option value="periodic_or_marker">Periodic or explicit marker only</option><option value="periodic_only">Periodic only</option><option value="always">Always run on trigger</option></select></div>
        <div class="sfe-row"><label for="sfe_periodic_user_messages">Every N user messages</label><input id="sfe_periodic_user_messages" type="number" min="1" max="50" step="1"></div>
      </fieldset>

      <fieldset><legend>Extractor</legend>
        <div class="sfe-row"><label for="sfe_endpoint">Endpoint</label><input id="sfe_endpoint" type="text" spellcheck="false"></div>
        <div class="sfe-row"><label for="sfe_model">Model</label><input id="sfe_model" type="text" spellcheck="false"></div>
        <div class="sfe-row"><label for="sfe_apikey">API key</label><input id="sfe_apikey" type="text" spellcheck="false" placeholder="blank for LM Studio"></div>
        <div class="sfe-row"><label for="sfe_recent_limit">Recent messages</label><input id="sfe_recent_limit" type="number" min="2" max="40" step="1"><label for="sfe_max_tokens">Max output tokens</label><input id="sfe_max_tokens" type="number" min="100" max="4000" step="50"></div>
        <div class="sfe-row"><label for="sfe_max_input_chars">Max chars/message</label><input id="sfe_max_input_chars" type="number" min="200" max="4000" step="100"><label for="sfe_max_payload_chars">Max payload chars</label><input id="sfe_max_payload_chars" type="number" min="4000" max="60000" step="1000"></div>
        <div class="sfe-row"><label for="sfe_max_previous_events_payload">Prev events in prompt</label><input id="sfe_max_previous_events_payload" type="number" min="0" max="12" step="1"><label><input id="sfe_json_response" type="checkbox"> Request JSON response_format</label></div>
      </fieldset>

      <fieldset><legend>Event gating</legend>
        <div class="sfe-row"><label><input id="sfe_strict_events" type="checkbox"> Strict RecentEvents gate</label></div>
        <div class="sfe-row"><label for="sfe_min_event_importance">Min event importance</label><input id="sfe_min_event_importance" type="number" min="0" max="5" step="1"><label for="sfe_max_events_per_proposal">Max events/proposal</label><input id="sfe_max_events_per_proposal" type="number" min="0" max="3" step="1"></div>
        <div class="sfe-row"><label for="sfe_recent_event_coalescing_mode">RecentEvents coalescing</label><select id="sfe_recent_event_coalescing_mode"><option value="conservative">Conservative</option><option value="off">Off</option></select></div>
        <div class="sfe-row"><label><input id="sfe_event_cue_prefilter" type="checkbox"> High-salience event cue prefilter</label></div>
      </fieldset>

      <fieldset><legend>Scene handling</legend>
        <div class="sfe-row"><label><input id="sfe_scene_cue_prefilter" type="checkbox"> Scene cue prefilter</label><label><input id="sfe_remote_cue_prefilter" type="checkbox"> Remote/split-scene cue prefilter</label></div>
        <div class="sfe-row"><label for="sfe_scene_marker_regex">Scene marker regex</label><input id="sfe_scene_marker_regex" type="text" spellcheck="false"></div>
        <div class="sfe-row"><label><input id="sfe_clear_objects_on_location_change" type="checkbox"> Expire old room objects on location change</label></div>
        <div class="sfe-row"><label for="sfe_surroundings_mode">Surroundings update mode</label><select id="sfe_surroundings_mode"><option value="location_only">Location/sub-location/environment only</option><option value="normal">Normal extractor output</option></select></div>
        <div class="sfe-row"><label for="sfe_object_coalescing_mode">Object coalescing mode</label><select id="sfe_object_coalescing_mode"><option value="conservative">Conservative: cash + identical generic objects</option><option value="off">Off</option></select></div>
        <div class="sfe-row"><label for="sfe_scene_reconciliation_mode">Scene reconciliation mode</label><select id="sfe_scene_reconciliation_mode"><option value="suppress_participant_blocking">Suppress participant/body-position objects</option><option value="off">Off</option></select></div>
      </fieldset>
    </div>
  </details>
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
    bindSetting('sfe_max_input_chars', 'maxInputCharsPerTurn', 'number');
    bindSetting('sfe_max_previous_events_payload', 'maxPreviousRecentEventsForPayload', 'number');
    bindSetting('sfe_max_payload_chars', 'maxExtractorPayloadChars', 'number');
    bindSetting('sfe_trigger', 'trigger');
    bindSetting('sfe_autorun_policy', 'autoRunPolicy');
    bindSetting('sfe_periodic_user_messages', 'periodicUserMessages', 'number');
    bindSetting('sfe_scene_cue_prefilter', 'sceneCuePrefilter', 'boolean');
    bindSetting('sfe_event_cue_prefilter', 'highSalienceEventCuePrefilter', 'boolean');
    bindSetting('sfe_remote_cue_prefilter', 'remoteCommunicationCuePrefilter', 'boolean');
    bindSetting('sfe_scene_marker_regex', 'sceneMarkerRegex');
    bindSetting('sfe_json_response', 'responseFormatJson', 'boolean');
    bindSetting('sfe_strict_events', 'strictRecentEvents', 'boolean');
    bindSetting('sfe_min_event_importance', 'minEventImportance', 'number');
    bindSetting('sfe_max_events_per_proposal', 'maxEventsPerProposal', 'number');
    bindSetting('sfe_recent_event_coalescing_mode', 'recentEventsCoalescingMode');
    bindSetting('sfe_clear_objects_on_location_change', 'clearRoomObjectsOnLocationChange', 'boolean');
    bindSetting('sfe_surroundings_mode', 'surroundingsUpdateMode');
    bindSetting('sfe_object_coalescing_mode', 'objectCoalescingMode');
    bindSetting('sfe_scene_reconciliation_mode', 'sceneReconciliationMode');

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
    document.getElementById('sfe_clear_objects')?.addEventListener('click', () => clearNearbyObjects());
    document.getElementById('sfe_coalesce_objects')?.addEventListener('click', () => coalesceCurrentObjects());
    document.getElementById('sfe_reconcile_scene')?.addEventListener('click', () => reconcileCurrentScene());
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
