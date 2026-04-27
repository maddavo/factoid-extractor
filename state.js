// Shared SillyTavern context, settings, metadata, and text helpers.

import { EXTENSION_VERSION, MODULE_NAME, MODULE_TITLE, DEFAULT_SETTINGS, EMPTY_SCENE } from './constants.js';

export function ctx() {
    return globalThis.SillyTavern?.getContext?.() || {};
}

export function settings() {
    const context = ctx();
    context.extensionSettings = context.extensionSettings || {};
    context.extensionSettings[MODULE_NAME] = context.extensionSettings[MODULE_NAME] || {};
    const s = context.extensionSettings[MODULE_NAME];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

export function saveSettings() {
    const context = ctx();
    context.saveSettingsDebounced?.();
}

export function defaultMetadata() {
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

export function metadata() {
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

export async function saveMetadataNow() {
    const context = ctx();
    if (typeof context.saveMetadata === 'function') {
        await context.saveMetadata();
    } else if (typeof context.saveMetadataDebounced === 'function') {
        context.saveMetadataDebounced();
    }
}

export function structuredCloneSafe(obj) {
    try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); }
}

export function logDebug(...args) {
    if (settings().debug) console.debug(`[${MODULE_TITLE}]`, ...args);
}

export function toastInfo(message) { globalThis.toastr?.info?.(message, MODULE_TITLE); }
export function toastWarn(message) { globalThis.toastr?.warning?.(message, MODULE_TITLE); }
export function toastError(message) { globalThis.toastr?.error?.(message, MODULE_TITLE); }

export function sanitizeText(text) {
    if (text === null || text === undefined) return '';
    if (typeof text === 'object') return sanitizeObjectText(text);
    return String(text)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function sanitizeObjectText(value) {
    if (!value || typeof value !== 'object') return '';
    const candidate = value.name ?? value.object ?? value.object_name ?? value.item ?? value.label ?? value.summary ?? value.text ?? '';
    if (candidate) return sanitizeText(candidate);
    try { return JSON.stringify(value); } catch { return ''; }
}

export function objectRemoveName(value) {
    if (typeof value === 'string') return sanitizeText(value);
    if (!value || typeof value !== 'object') return '';
    return sanitizeText(value.name ?? value.object ?? value.object_name ?? value.item ?? value.label ?? value.target ?? value.current_name ?? '');
}

export function roleOfMessage(message) {
    if (message?.is_system) return 'system';
    if (message?.is_user) return 'user';
    if (message?.extra?.type === 'system') return 'system';
    return 'assistant';
}

export function speakerOfMessage(message, fallbackRole) {
    return sanitizeText(message?.name || message?.original_avatar || fallbackRole || 'unknown');
}

export function getRecentTurns(limit) {
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

export function chatSignature() {
    const chat = ctx().chat || [];
    const last = chat[chat.length - 1];
    const prev = chat[chat.length - 2];
    return JSON.stringify({
        length: chat.length,
        last: sanitizeText(last?.mes).slice(0, 500),
        prev: sanitizeText(prev?.mes).slice(0, 200)
    });
}

export function userMessageCount() {
    const chat = ctx().chat || [];
    return chat.filter(message => roleOfMessage(message) === 'user').length;
}

export function recentChatText(limit = 6) {
    const chat = ctx().chat || [];
    return chat.slice(Math.max(0, chat.length - limit)).map(message => sanitizeText(message?.mes)).join('\n');
}

export function addUnique(arr, value) {
    if (!value) return;
    if (!arr.some(x => sameText(x, value))) arr.push(value);
}

export function removeByCaseInsensitive(arr, value) {
    const i = arr.findIndex(x => sameText(x, value));
    if (i >= 0) arr.splice(i, 1);
}

export function sameText(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}


export function canonicalKey(value) {
    return String(value || '').trim().toLowerCase();
}

export function displayLocationForObject(location, sceneRef = '') {
    const loc = sanitizeText(location);
    const scene = sanitizeText(sceneRef || metadata().currentScene?.location_ref);
    if (!loc) return '';
    const text = loc.trim();
    const hasExplicitPlace = /\b(cafeteria|dorm|bathroom|hallway|kitchen|bedroom|office|study|room|entrance)\b/i.test(text);
    const genericLocal = /^(\s*the\s+)?(floor|ground|desk|table|chair|bed|door|doorway|door frame|counter|bench)$/i.test(text)
        || /^(on|under|beside|near|next to|against|by)\b/i.test(text)
        || (/\b(floor|desk|table|chair|bed|door frame|counter|bench)\b/i.test(text) && !hasExplicitPlace);
    if (scene && genericLocal && !text.toLowerCase().includes(scene.toLowerCase())) {
        return `${scene} — ${text}`;
    }
    return text;
}

