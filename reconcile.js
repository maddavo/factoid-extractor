// Scene reconciliation, object coalescing, proposal normalization, and RecentEvents gates.

import { EMPTY_SCENE } from './constants.js';
import { metadata, settings, sanitizeText, objectRemoveName, addUnique, removeByCaseInsensitive, sameText, recentChatText, canonicalKey, displayLocationForObject } from './state.js';

const KNOWN_CHARACTER_ALIASES = Object.freeze([
    'davo',
    'sage',
    'sage morgan-burke',
    'quinn',
    'maya',
    'maya bailey',
    'josy',
    'josy taylor',
    'jill',
    'bella',
    'isabella',
    'zoey',
    'riona',
    'camila',
    'lily',
    'nicole',
    'sarah',
    'melanie',
    'heather'
]);

function sceneReconciliationEnabled() {
    return (settings().sceneReconciliationMode || 'suppress_participant_blocking') !== 'off';
}

function stripEntityQualifier(value) {
    return sanitizeText(value)
        .replace(/\s+—.*$/g, '')
        .replace(/\s+-\s+(?:local|remote|present|texting|phone).*$/i, '')
        .trim();
}

function canonicalEntityAlias(value) {
    return stripEntityQualifier(value)
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function addEntityAliases(set, value) {
    const full = canonicalEntityAlias(value);
    if (!full) return;
    set.add(full);
    const first = full.split(/\s+/)[0];
    if (first) set.add(first);
}

function knownEntityAliasSet(delta = null) {
    const aliases = new Set(KNOWN_CHARACTER_ALIASES);
    const current = metadata().currentScene || EMPTY_SCENE;
    for (const ent of current.present_entities || []) addEntityAliases(aliases, ent);
    const su = delta?.scene_update || {};
    for (const ent of su.present_entities_add || []) addEntityAliases(aliases, ent);
    for (const ent of su.present_entities_remove || []) addEntityAliases(aliases, ent);
    return aliases;
}

function isParticipantObjectName(name, delta = null) {
    const full = canonicalEntityAlias(name);
    if (!full) return false;
    const aliases = knownEntityAliasSet(delta);
    return aliases.has(full);
}

function isBodyPartOrTransientContactObjectName(name) {
    const t = sanitizeText(name).toLowerCase();
    if (!t) return false;
    const possessive = /(?:davo|sage|quinn|maya|josy|jill|bella|zoey|riona|camila|lily|nicole|sarah|melanie|heather|his|her|their)[’']?s?\s+/i.test(t);
    const bodyPart = /\b(waist|hips?|hip|chest|thighs?|legs?|arms?|hands?|fingers?|mouth|lips?|neck|shoulders?|back|body|bodies|skin|hair|face|ass|butt|crotch|cock|pussy|breasts?|nipples?)\b/i.test(t);
    return possessive && bodyPart;
}

function isTransientParticipantLocation(location) {
    const t = sanitizeText(location).toLowerCase();
    if (!t) return false;
    return /\b(standing|sitting next to|sitting beside|moving toward|moves toward|walking toward|space between|between .* and|beside .* hip|near .* hip|in .* grasp|being touched|touching|grabbed|grabbing|held by|holding|pressed against|pressing against|leaning|straddl|kneel|on top of|underneath|behind .* body|against him|against her|kiss|kissing|sexual position|body position|blocking)\b/i.test(t);
}

function hasStableObjectAnchor(location) {
    const t = sanitizeText(location).toLowerCase();
    if (!t) return false;
    return /\b(couch|bed|floor|table|desk|chair|counter|bench|bag|pocket|drawer|shelf|tripod|green-screen|camera|room|kitchen|bathroom|shower|door|wall|loungeroom|apartment|mansion|hallway|bar|bin|trash|basket)\b/i.test(t);
}

function shouldRejectSceneObject(obj, delta = null) {
    const name = sanitizeText(obj?.name);
    const location = sanitizeText(obj?.location);
    if (!name || !location) return { reject: false, reason: '' };
    if (isParticipantObjectName(name, delta)) {
        return { reject: true, reason: 'Participant/body-blocking facts belong in present_entities, not nearby_objects.' };
    }
    if (isBodyPartOrTransientContactObjectName(name)) {
        return { reject: true, reason: 'Body parts and transient physical contact are not stable nearby practical objects.' };
    }
    if (isTransientParticipantLocation(location) && !hasStableObjectAnchor(location)) {
        return { reject: true, reason: 'Transient pose/contact/blocking location is not a stable object location.' };
    }
    if (/\b(unzipped|being touched|being grabbed|being held|pressed against|skin|body)\b/i.test(location) && !hasStableObjectAnchor(location)) {
        return { reject: true, reason: 'Transient clothing/body interaction is not a stable scene object location.' };
    }
    return { reject: false, reason: '' };
}

function filterParticipantBlockingDelta(delta) {
    if (!sceneReconciliationEnabled()) return delta;
    const su = delta?.scene_update || {};
    if (!Array.isArray(su.nearby_objects_add_or_update)) return delta;

    const rejected = [];
    const kept = [];
    su.present_entities_add = su.present_entities_add || [];

    for (const obj of su.nearby_objects_add_or_update) {
        const name = sanitizeText(obj?.name);
        const location = sanitizeText(obj?.location);
        const decision = shouldRejectSceneObject({ name, location }, delta);
        if (decision.reject) {
            rejected.push({ candidate: `${location}: ${name}`, reason: decision.reason });
            if (isParticipantObjectName(name, delta)) {
                const ent = stripEntityQualifier(name);
                const currentPresent = metadata().currentScene?.present_entities || [];
                const alreadyPresent = currentPresent.some(existing => sameText(stripEntityQualifier(existing), ent))
                    || su.present_entities_add.some(existing => sameText(stripEntityQualifier(existing), ent));
                if (ent && !alreadyPresent) su.present_entities_add.push(ent);
            }
            continue;
        }
        kept.push(obj);
    }

    su.nearby_objects_add_or_update = kept;
    if (rejected.length) {
        delta.rejected_candidates = [ ...(delta.rejected_candidates || []), ...rejected ];
        if (!hasSubstantiveDelta(delta) && !delta.no_update_reason) {
            delta.no_update_reason = 'Extractor proposed only transient participant/body-position facts; no stable Phase 1 scene update remains.';
        }
    }
    return delta;
}

export function reconcileSceneObjectsForStorage(scene) {
    if (!sceneReconciliationEnabled()) return scene;
    const kept = [];
    for (const obj of scene.nearby_objects || []) {
        const decision = shouldRejectSceneObject(obj, { scene_update: { present_entities_add: scene.present_entities || [] } });
        if (!decision.reject) kept.push(obj);
    }
    scene.nearby_objects = kept;
    return scene;
}

function objectCoalescingEnabled() {
    return (settings().objectCoalescingMode || 'conservative') !== 'off';
}

function objectLocationGroupKey(obj, fallbackScene = '') {
    const location = sanitizeText(obj?.location);
    const sceneRef = sanitizeText(obj?.scene_ref || fallbackScene);
    return `${sceneRef.toLowerCase()}||${location.toLowerCase()}`;
}

function parseCashAmount(text) {
    const t = sanitizeText(text);
    if (!t) return null;
    if (/cash register|cash box|cashier/i.test(t)) return null;
    let m = /(?:AUD\s*)?\$\s*(\d+(?:\.\d{1,2})?)/i.exec(t);
    if (m) return Number(m[1]);
    m = /\b(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks?)\b/i.exec(t);
    if (m) return Number(m[1]);
    return null;
}

function isCashObject(obj) {
    const name = sanitizeText(obj?.name);
    return parseCashAmount(name) !== null && /\$|cash|money|dollars?|bucks?/i.test(name);
}

function componentKey(component) {
    return `${sanitizeText(component?.name).toLowerCase()}||${Number(component?.amount || 0)}`;
}

function cashComponentsFromObject(obj) {
    const existing = Array.isArray(obj?.components) ? obj.components : [];
    const out = [];
    for (const c of existing) {
        const amount = Number(c?.amount ?? parseCashAmount(c?.name));
        const name = sanitizeText(c?.name || obj?.name);
        if (name && Number.isFinite(amount) && amount > 0) out.push({ name, amount });
    }
    if (out.length) return out;
    const amount = parseCashAmount(obj?.name);
    const name = sanitizeText(obj?.name);
    if (name && Number.isFinite(amount) && amount > 0) return [{ name, amount }];
    return [];
}

function formatMoneyAmount(amount) {
    const n = Number(amount || 0);
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/,'').replace(/\.$/,'');
}

function normalizeGenericObjectName(name) {
    let t = sanitizeText(name).toLowerCase();
    if (!t) return '';
    if (/\b(sage|davo|josy|quinn|maya|bella|jill|mc|user)'s\b/i.test(t)) return '';
    if (/\b(phone|key|keycard|letter|note|weapon|gun|knife|evidence|gift|bag|jacket|shirt|pants|dress|bra|underwear|contract|document|id card|wallet|purse)\b/i.test(t)) return '';
    if (!/\b(bottle|can|cup|glass|plate|paper|flyer|ticket|napkin|coin|beer|shot)\b/i.test(t)) return '';
    t = t.replace(/\s+from\s+.+$/i, '');
    t = t.replace(/\s*\([^)]*\)\s*$/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(/s$/i, '');
    return t;
}

function pluralizeGenericName(base, count) {
    if (count === 1) return base;
    if (/y$/i.test(base)) return base.replace(/y$/i, 'ies');
    if (/(s|x|ch|sh)$/i.test(base)) return `${base}es`;
    return `${base}s`;
}

export function coalesceNearbyObjects(objects, fallbackScene = '', turn = 0) {
    if (!objectCoalescingEnabled()) return Array.isArray(objects) ? objects : [];
    const input = (Array.isArray(objects) ? objects : []).filter(o => o && (o.name || o.location));
    if (!input.length) return [];

    const used = new Set();
    const result = [];

    const cashGroups = new Map();
    input.forEach((obj, idx) => {
        if (!isCashObject(obj)) return;
        const key = objectLocationGroupKey(obj, fallbackScene);
        if (!cashGroups.has(key)) cashGroups.set(key, []);
        cashGroups.get(key).push({ obj, idx });
    });

    for (const group of cashGroups.values()) {
        const components = [];
        const seenComponents = new Set();
        for (const { obj, idx } of group) {
            for (const comp of cashComponentsFromObject(obj)) {
                const key = componentKey(comp);
                if (!key || seenComponents.has(key)) continue;
                seenComponents.add(key);
                components.push(comp);
            }
            used.add(idx);
        }
        const total = components.reduce((sum, c) => sum + Number(c.amount || 0), 0);
        if (total > 0) {
            const first = group[0].obj;
            result.push({
                name: `$${formatMoneyAmount(total)} cash`,
                location: sanitizeText(first.location),
                scene_ref: sanitizeText(first.scene_ref || fallbackScene),
                evidence: `Coalesced cash from: ${components.map(c => c.name).join('; ')}`,
                last_updated_turn: turn || first.last_updated_turn || 0,
                coalesced_category: 'cash',
                quantity: total,
                unit: '$',
                components
            });
        }
    }

    const genericGroups = new Map();
    input.forEach((obj, idx) => {
        if (used.has(idx)) return;
        const base = normalizeGenericObjectName(obj.name);
        if (!base) return;
        const key = `${objectLocationGroupKey(obj, fallbackScene)}||${base}`;
        if (!genericGroups.has(key)) genericGroups.set(key, { base, entries: [] });
        genericGroups.get(key).entries.push({ obj, idx });
    });

    for (const group of genericGroups.values()) {
        if (group.entries.length < 2) continue;
        const first = group.entries[0].obj;
        for (const { idx } of group.entries) used.add(idx);
        result.push({
            name: `${group.entries.length} ${pluralizeGenericName(group.base, group.entries.length)}`,
            location: sanitizeText(first.location),
            scene_ref: sanitizeText(first.scene_ref || fallbackScene),
            evidence: `Coalesced from: ${group.entries.map(e => sanitizeText(e.obj.name)).join('; ')}`,
            last_updated_turn: turn || first.last_updated_turn || 0,
            coalesced_category: 'generic',
            quantity: group.entries.length,
            components: group.entries.map(e => ({ name: sanitizeText(e.obj.name), amount: 1 }))
        });
    }

    input.forEach((obj, idx) => {
        if (!used.has(idx)) result.push(obj);
    });
    return result;
}

export function coalesceSceneUpdateObjects(delta) {
    if (!objectCoalescingEnabled()) return delta;
    const su = delta?.scene_update;
    if (!su || !Array.isArray(su.nearby_objects_add_or_update)) return delta;
    const sceneRef = sanitizeText(su.location_ref || metadata().currentScene?.location_ref);
    su.nearby_objects_add_or_update = coalesceNearbyObjects(su.nearby_objects_add_or_update, sceneRef, 0);
    return delta;
}

export function normalizeProposal(raw) {
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

    filterParticipantBlockingDelta(normalized);
    normalizeSplitRemoteSceneDelta(normalized);
    filterSurroundingsDelta(normalized);
    coalesceSceneUpdateObjects(normalized);
    return filterNoOpSceneDelta(normalized);
}


function normalizeSplitRemoteSceneDelta(delta) {
    if (!settings().remoteCommunicationCuePrefilter) return delta;
    const su = delta?.scene_update || {};
    const combined = [su.location_ref, su.surroundings_summary, recentChatText(12)].map(sanitizeText).join(' ').toLowerCase();
    const splitLikely = /\bsplit scene\b|\bphysically separated\b|\bremote\b|\btext(?:s|ing)?\b|\bphone\b|\bcall(?:s|ing)?\b|\bexam hall\b|\bhots kitchen\b/.test(combined)
        && /\b(davo|sage)\b/.test(combined);
    if (!splitLikely) return delta;

    const addSet = new Set((su.present_entities_add || []).map(canonicalKey));
    const hasQualified = (su.present_entities_add || []).some(ent => /—|\bremote\b|\blocal\b|\btexting\b|\bphone\b|\bexam hall\b|\bkitchen\b/i.test(ent));
    const currentPresent = Array.isArray(metadata().currentScene?.present_entities) ? metadata().currentScene.present_entities : [];

    // Avoid false co-presence: if the model added qualified split-entities, remove old unqualified entries.
    if (hasQualified) {
        su.present_entities_remove = su.present_entities_remove || [];
        for (const ent of currentPresent) {
            const plain = sanitizeText(ent);
            if (!plain) continue;
            if (/—|\bremote\b|\blocal\b|\btexting\b|\bphone\b/i.test(plain)) continue;
            const firstName = canonicalKey(plain.split(/\s+/)[0]);
            const covered = [...addSet].some(x => firstName && x.includes(firstName));
            if (covered && !su.present_entities_remove.some(existing => sameText(existing, plain))) {
                su.present_entities_remove.push(plain);
            }
        }
    }

    if (su.location_ref && !/^split scene\s*:/i.test(su.location_ref) && /\b(text|phone|call|remote|physically separated|exam hall)\b/i.test(combined)) {
        delta.rejected_candidates = [
            ...(delta.rejected_candidates || []),
            { candidate: 'Split-location remote communication', reason: 'Ensure packet does not imply physical co-presence; location_ref should be a split-scene line if both characters remain active in different places.' }
        ];
    }
    return delta;
}

export function isSplitSceneState(scene) {
    const combined = `${scene?.location_ref || ''} ${scene?.surroundings_summary || ''}`.toLowerCase();
    return /\bsplit scene\b|\bphysically separated\b|\bremote\b|\btexting\b|\bphone\b|\bexam hall\b/.test(combined)
        && /\b(davo|sage)\b/.test(combined);
}

function filterSurroundingsDelta(delta) {
    const su = delta?.scene_update || {};
    if (su.surroundings_summary === null || su.surroundings_summary === undefined || su.surroundings_summary === '') return delta;
    const mode = settings().surroundingsUpdateMode || 'location_only';
    if (mode === 'normal') return delta;

    const current = metadata().currentScene || EMPTY_SCENE;
    const nextLocation = sanitizeText(su.location_ref);
    const currentLocation = sanitizeText(current.location_ref);
    const locationChanges = Boolean(nextLocation && currentLocation && !sameText(nextLocation, currentLocation));
    const initialLocationSet = Boolean(nextLocation && !currentLocation);
    const summary = sanitizeText(su.surroundings_summary);

    if (locationChanges || initialLocationSet) return delta;
    if (isStableEnvironmentSurroundings(summary)) return delta;
    if (isRemoteCommunicationSurroundings(summary)) return delta;

    const reason = isTransientBodyOrInteractionSummary(summary)
        ? 'Suppressed surroundings update: body position/touch/intensity/blocking changes are not stable scene surroundings.'
        : 'Suppressed surroundings update: location-only mode allows surroundings changes only for location/sub-location or stable environmental anchors.';
    su.surroundings_summary = null;
    delta.rejected_candidates = [
        ...(delta.rejected_candidates || []),
        { candidate: `Surroundings: ${summary}`, reason }
    ];
    if (!hasSubstantiveDelta(delta) && !delta.no_update_reason) {
        delta.no_update_reason = 'Only a non-stable surroundings change was proposed.';
    }
    return delta;
}

function isStableEnvironmentSurroundings(text) {
    const t = sanitizeText(text).toLowerCase();
    if (!t) return false;
    const stableEnvironment = /\b(door|window|lock|locked|unlocked|open|opened|closed|shut|lights?|dark|lit|lamp|power|outage|shower|bathroom|water|running|faucet|tap|flood|flooded|smoke|fire|alarm|broken|breaks|damaged|spilled|spill|mess|blocked|barricaded|curtain|blind|heater|fan|air conditioner|ac)\b/;
    const subLocation = /\b(bathroom|shower|hallway|corridor|doorway|entrance|balcony|outside|inside|kitchen|office|garage|car|street|yard|library|cafeteria|classroom|bedroom)\b/;
    return stableEnvironment.test(t) || subLocation.test(t);
}

function isRemoteCommunicationSurroundings(text) {
    const t = sanitizeText(text).toLowerCase();
    if (!t) return false;
    return /\b(texting|text message|phone|call|calling|video call|physically separated|remote communication|not in the same room|split scene|exam hall)\b/.test(t)
        && /\b(davo|sage)\b/.test(t);
}

function isTransientBodyOrInteractionSummary(text) {
    const t = sanitizeText(text).toLowerCase();
    if (!t) return false;
    return /\b(kiss|kissing|touch|touching|grab|grabs|grabbing|hold|holds|holding|waist|hips?|chest|thigh|legs?|arms?|hands?|body|bodies|position|pose|posing|on top|underneath|behind|against him|against her|leaning|straddl|kneel|standing over|bent|press(?:ed|ing)?|intensity|tempo|rhythm|moan|sexual|intimate)\b/.test(t);
}


function recentEventCoalescingEnabled() {
    return (settings().recentEventsCoalescingMode || 'conservative') !== 'off';
}

const EVENT_STOPWORDS = new Set([
    'the','a','an','and','or','but','if','then','with','without','to','of','in','on','at','by','for','from','as','is','are','was','were','be','been','being',
    'has','have','had','does','do','did','will','would','could','should','may','might','must','can','cannot','not','no','yes','it','this','that','these','those',
    'their','his','her','him','she','he','they','them','after','before','because','about','into','onto','over','under','again','still','now','just','very'
]);

const EVENT_PERSON_TOKENS = [
    'davo','sage','quinn','maya','josy','jill','bella','isabella','zoey','riona','camila','lily','nicole','sarah','melanie','heather'
];

function eventText(event) {
    return sanitizeText(`${event?.summary || ''} ${event?.causal_result || ''}`);
}

function normalizedEventText(event) {
    return eventText(event)
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9$ ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function eventTokenSet(event) {
    const tokens = normalizedEventText(event)
        .split(/\s+/)
        .filter(t => t.length > 2 && !EVENT_STOPWORDS.has(t));
    return new Set(tokens);
}

function eventPeopleSet(event) {
    const text = normalizedEventText(event);
    const people = new Set();
    for (const person of EVENT_PERSON_TOKENS) {
        if (new RegExp(`\\b${person}\\b`, 'i').test(text)) people.add(person);
    }
    return people;
}

function eventHasAny(text, words) {
    return words.some(word => new RegExp(`\\b${word}\\b`, 'i').test(text));
}

function eventCategory(event) {
    const text = normalizedEventText(event);
    if (eventHasAny(text, ['girlfriend','boyfriend','partner','relationship','dating','official','couple','master','mistress','dominant','submissive','owner','owned','belongs','claimed','collar','protocol','safeword'])) return 'relationship_status';
    if (eventHasAny(text, ['promise','promised','agreed','owes','owe','must','needs','need','task','deadline','plan','remind','remember','waiting','depends','blocked'])) return 'task_obligation';
    if (eventHasAny(text, ['lost','missing','broken','stolen','hidden','damaged','locked','unlocked','open','closed'])) return 'practical_state';
    if (eventHasAny(text, ['hurt','upset','cried','crying','tear','tears','distressed','worried','angry','embarrassed','ashamed'])) return 'emotional_consequence';
    return 'general';
}

function setIntersects(a, b) {
    for (const item of a) if (b.has(item)) return true;
    return false;
}

function tokenJaccard(a, b) {
    if (!a.size && !b.size) return 0;
    let inter = 0;
    for (const item of a) if (b.has(item)) inter++;
    const union = new Set([...a, ...b]).size;
    return union ? inter / union : 0;
}

function sameRecentEventCluster(a, b) {
    const ta = normalizedEventText(a);
    const tb = normalizedEventText(b);
    if (!ta || !tb) return false;
    if (ta === tb) return true;
    if (ta.length > 24 && tb.includes(ta)) return true;
    if (tb.length > 24 && ta.includes(tb)) return true;

    const ca = eventCategory(a);
    const cb = eventCategory(b);
    const peopleA = eventPeopleSet(a);
    const peopleB = eventPeopleSet(b);
    const sharedPeople = setIntersects(peopleA, peopleB) || (!peopleA.size && !peopleB.size);

    if (ca === 'relationship_status' && cb === 'relationship_status' && sharedPeople) return true;
    if (ca === cb && ca !== 'general' && sharedPeople) {
        const ja = tokenJaccard(eventTokenSet(a), eventTokenSet(b));
        if (ja >= 0.28) return true;
    }

    const ja = tokenJaccard(eventTokenSet(a), eventTokenSet(b));
    return sharedPeople && ja >= 0.45;
}

function mergeEvidence(a, b) {
    const parts = [];
    for (const item of [a, b]) {
        const text = sanitizeText(item);
        if (text && !parts.some(existing => sameText(existing, text))) parts.push(text);
    }
    return parts.join(' | ').slice(0, 500);
}

function chooseEventText(existingValue, incomingValue) {
    const oldText = sanitizeText(existingValue);
    const newText = sanitizeText(incomingValue);
    if (!oldText) return newText;
    if (!newText) return oldText;
    if (newText.length > oldText.length && newText.length <= 240) return newText;
    return oldText;
}

function mergeRecentEvent(existing, incoming) {
    existing.summary = chooseEventText(existing.summary, incoming.summary);
    existing.causal_result = chooseEventText(existing.causal_result, incoming.causal_result);
    existing.resolved = Boolean(existing.resolved) || Boolean(incoming.resolved);
    existing.importance_score = Math.max(Number(existing.importance_score || 0), Number(incoming.importance_score || 0));
    existing.evidence = mergeEvidence(existing.evidence, incoming.evidence);
    existing.created_turn = Math.min(Number(existing.created_turn || incoming.created_turn || 0), Number(incoming.created_turn || existing.created_turn || 0)) || existing.created_turn || incoming.created_turn;
    existing.last_updated_turn = Math.max(Number(existing.last_updated_turn || 0), Number(incoming.last_updated_turn || 0));
    return existing;
}

export function coalesceRecentEvents(events) {
    const input = Array.isArray(events) ? events.filter(Boolean) : [];
    if (!recentEventCoalescingEnabled()) return input;

    const result = [];
    for (const event of input) {
        if (!eventRenderable(event)) continue;
        const existing = result.find(candidate => sameRecentEventCluster(candidate, event));
        if (existing) {
            mergeRecentEvent(existing, event);
        } else {
            result.push({ ...event });
        }
    }
    return result;
}


export function filterNoOpSceneDelta(delta) {
    const m = metadata();
    const current = m.currentScene || EMPTY_SCENE;
    const su = delta.scene_update || {};
    const rejected = [];

    if (su.location_ref !== null && sameText(su.location_ref, current.location_ref)) {
        rejected.push({ candidate: `Current location: ${su.location_ref}`, reason: 'No-op scene update: current location is already stored.' });
        su.location_ref = null;
    }

    if (su.surroundings_summary !== null && sameText(su.surroundings_summary, current.surroundings_summary)) {
        rejected.push({ candidate: `Surroundings: ${su.surroundings_summary}`, reason: 'No-op scene update: surroundings summary is already stored.' });
        su.surroundings_summary = null;
    }

    const present = Array.isArray(current.present_entities) ? current.present_entities : [];
    su.present_entities_add = (su.present_entities_add || []).filter(ent => {
        if (present.some(existing => sameText(existing, ent))) {
            rejected.push({ candidate: `Present entity: ${ent}`, reason: 'No-op entity update: entity is already present.' });
            return false;
        }
        return true;
    });
    su.present_entities_remove = (su.present_entities_remove || []).filter(ent => {
        if (!present.some(existing => sameText(existing, ent))) {
            rejected.push({ candidate: `Remove present entity: ${ent}`, reason: 'No-op entity removal: entity is not currently present.' });
            return false;
        }
        return true;
    });

    const proposedUpdatesByName = new Map();
    const keptUpdates = [];

    for (const obj of su.nearby_objects_add_or_update || []) {
        const name = sanitizeText(obj?.name);
        const location = sanitizeText(obj?.location);
        if (!name || !location) continue;
        const existing = findCurrentObjectByName(name);
        if (existing && objectLocationSame(existing, obj)) {
            const loc = displayLocationForObject(existing.location, existing.scene_ref || current.location_ref);
            rejected.push({ candidate: `${loc}: ${name}`, reason: 'No-op object update: object is already stored at that location.' });
            proposedUpdatesByName.set(canonicalKey(name), { obj, noOp: true });
            continue;
        }
        keptUpdates.push(obj);
        proposedUpdatesByName.set(canonicalKey(name), { obj, noOp: false });
    }
    su.nearby_objects_add_or_update = keptUpdates;

    const seenRemoves = new Set();
    const keptRemoves = [];
    for (const rawRemove of su.nearby_objects_remove || []) {
        const name = objectRemoveName(rawRemove);
        const key = canonicalKey(name);
        if (!key || seenRemoves.has(key)) continue;
        seenRemoves.add(key);

        const currentObj = findCurrentObjectByName(name);
        const proposed = proposedUpdatesByName.get(key);
        if (proposed) {
            const loc = currentObj
                ? displayLocationForObject(currentObj.location, currentObj.scene_ref || current.location_ref)
                : displayLocationForObject(proposed.obj?.location, current.location_ref);
            rejected.push({ candidate: `Remove ${loc ? loc + ': ' : ''}${name}`, reason: 'Conflicting object removal dropped: same proposal also states the object is present/updated.' });
            continue;
        }
        if (!currentObj) {
            rejected.push({ candidate: `Remove object: ${name}`, reason: 'No-op object removal: object is not currently stored.' });
            continue;
        }
        keptRemoves.push(name);
    }
    su.nearby_objects_remove = keptRemoves;

    if (rejected.length) {
        delta.rejected_candidates = [ ...(delta.rejected_candidates || []), ...rejected ];
        if (!hasSubstantiveDelta(delta) && !delta.no_update_reason) {
            delta.no_update_reason = 'Extractor proposed only no-op or contradictory scene changes already covered by the applied state.';
        }
    }
    return delta;
}

function findCurrentObjectByName(name) {
    const currentObjects = metadata().currentScene?.nearby_objects || [];
    return currentObjects.find(o => sameText(o?.name, name)) || null;
}

function objectLocationSame(existing, proposed) {
    if (!existing || !proposed) return false;
    const currentScene = metadata().currentScene?.location_ref || '';
    const existingDisplay = displayLocationForObject(existing.location, existing.scene_ref || currentScene);
    const proposedDisplay = displayLocationForObject(proposed.location, proposed.scene_ref || currentScene);
    if (sameText(existingDisplay, proposedDisplay)) return true;
    if (sameText(existing.location, proposed.location)) return true;
    return false;
}

export function eventGateReason(event, minImportance, sceneUpdate = null) {
    const summary = sanitizeText(event?.summary);
    const result = sanitizeText(event?.causal_result);
    const evidence = sanitizeText(event?.evidence);
    const score = Number(event?.importance_score || 0);
    if (!summary) return 'Dropped RecentEvent candidate: missing summary.';
    if (!result) return 'Dropped RecentEvent candidate: no unresolved practical causal result.';
    if (!evidence) return 'Dropped RecentEvent candidate: no source evidence.';
    if (score < minImportance) return `Dropped RecentEvent candidate: importance ${score} below strict threshold ${minImportance}.`;

    const combined = `${summary} ${result}`.toLowerCase();

    const relationshipStatusPattern = /\b(girlfriend|boyfriend|partner|relationship|dating|official|couple|accepted .* request|agreed .* relationship|relationship status changed|became .* girlfriend|became .* boyfriend|became .* partner)\b/;
    const durableRoleStatusPattern = /\b(designat(?:ed|es)|establish(?:ed|es)|accepted|agreed|acknowledg(?:ed|es)|relationship\/role status changed|role status changed|explicitly .* as|called .* master|calls .* master|called .* mistress|calls .* mistress|safe word|safeword|protocol)\b/;
    const roleStatusPattern = /\b(master|mistress|dominant|submissive|dom\b|sub\b|owner|owned by|belong to|belongs to|claimed by|claim(?:ed)? .* as)\b/;
    const hasRelationshipStatusCue = relationshipStatusPattern.test(combined) || (roleStatusPattern.test(combined) && durableRoleStatusPattern.test(combined));

    const socialSexualColour = /\b(sexual|intimacy|intimate|undressed|removed .* pants|partially undressed|scandal|scandalous|shock|shocked|tension|social dynamic|escalated|highly sexualized|flirt|banter)\b/;
    if (socialSexualColour.test(combined) && !hasRelationshipStatusCue && !/\b(safe word|safeword|protocol|must respond|rule)\b/.test(combined)) {
        return 'Dropped RecentEvent candidate: social/sexual colour or transient escalation, not a durable Phase 1 event.';
    }

    const unresolvedPracticalPatterns = [
        /\b(broke|broken|breaks|damaged|damage|lost|missing|can't find|cannot find|not found|hid|hidden|stolen)\b/,
        /\b(promised|promise|agreed to|agreement|asked .* to|requested|request|task|deadline|urgent|must|needs to|need to|has to|still needs)\b/,
        /\b(plan changed|change of plan|new plan|remind|remember|waiting for|depends on|blocked|can't continue|cannot continue|owe|owed|due)\b/,
        /\b(interrupted by|alarm|phone call|knock at the door|emergency)\b/
    ];
    const hasUnresolvedPracticalCue = unresolvedPracticalPatterns.some(re => re.test(combined));
    if (!hasUnresolvedPracticalCue && !hasRelationshipStatusCue) {
        return 'Dropped RecentEvent candidate: no clear unresolved task/problem/changed-plan/relationship-status consequence beyond CurrentScene.';
    }

    if (sceneUpdate && eventDuplicatesSceneDelta(event, sceneUpdate)) {
        return 'Dropped RecentEvent candidate: already captured by CurrentScene/object state.';
    }

    return '';
}

export function eventDuplicatesSceneDelta(event, sceneUpdate) {
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

export function eventRenderable(event) {
    if (!event || event.resolved) return false;
    if (!settings().strictRecentEvents) return true;
    return !eventGateReason(event, Number(settings().minEventImportance || 4), null);
}

export function hasSubstantiveDelta(delta) {
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

