// Sage Phase 1 Factoid Extractor compatibility loader
// Loads the base extension and keeps its extractor model aligned with
// the active SillyTavern API connection profile Model ID when detectable.

import './index.js';
export { onActivate } from './index.js';

const SFE_MODULE_NAME = 'sage_phase1_factoid_extractor';
const LOCAL_MODEL_SENTINELS = new Set(['', 'local-model', 'local model', 'default', 'none', 'null', 'undefined']);
const MODEL_KEY_RE = /(^|_)(model|model_id|modelid|custom_model|openai_model|selected_model|chat_completion_model)$/i;

function getContext() {
    return globalThis.SillyTavern?.getContext?.() || {};
}

function cleanCandidate(value) {
    if (typeof value !== 'string') return '';
    const v = value.trim();
    if (!v) return '';
    if (LOCAL_MODEL_SENTINELS.has(v.toLowerCase())) return '';
    if (/^https?:\/\//i.test(v)) return '';
    if (v.length > 160) return '';
    if (/\s{2,}/.test(v)) return '';
    return v;
}

function valueFromPath(root, path) {
    let node = root;
    for (const part of path) {
        if (!node || typeof node !== 'object') return '';
        node = node[part];
    }
    return cleanCandidate(node);
}

function findModelInKnownSettings() {
    const context = getContext();
    const roots = [
        context,
        context.oai_settings,
        context.chatCompletionSettings,
        context.chat_completion_settings,
        context.apiSettings,
        context.api_settings,
        globalThis.oai_settings,
        globalThis.chatCompletionSettings,
        globalThis.chat_completion_settings,
        globalThis.apiSettings,
        globalThis.api_settings,
    ].filter(Boolean);

    const priorityPaths = [
        ['oai_settings', 'custom_model'],
        ['oai_settings', 'model'],
        ['oai_settings', 'model_id'],
        ['oai_settings', 'openai_model'],
        ['chatCompletionSettings', 'model'],
        ['chatCompletionSettings', 'model_id'],
        ['chat_completion_settings', 'model'],
        ['apiSettings', 'model'],
        ['api_settings', 'model'],
        ['custom_model'],
        ['model'],
        ['model_id'],
        ['modelId'],
        ['openai_model'],
        ['selected_model'],
        ['chat_completion_model'],
    ];

    for (const root of roots) {
        for (const path of priorityPaths) {
            const found = valueFromPath(root, path);
            if (found) return found;
        }
    }

    const seen = new WeakSet();
    function walk(obj, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 4 || seen.has(obj)) return '';
        seen.add(obj);
        for (const [key, value] of Object.entries(obj)) {
            if (key === SFE_MODULE_NAME) continue;
            if (MODEL_KEY_RE.test(key)) {
                const found = cleanCandidate(value);
                if (found) return found;
            }
        }
        for (const [key, value] of Object.entries(obj)) {
            if (key === SFE_MODULE_NAME) continue;
            const found = walk(value, depth + 1);
            if (found) return found;
        }
        return '';
    }

    for (const root of roots) {
        const found = walk(root);
        if (found) return found;
    }
    return '';
}

function findModelInDom() {
    const selectors = [
        '#custom_model',
        '#model_id',
        '#modelId',
        '#api_model',
        '#model_openai_select',
        '#chat_completion_model',
        'input[name="model"]',
        'select[name="model"]',
        'input[name="model_id"]',
        'select[name="model_id"]',
    ];

    for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
            if (el.closest?.('#sage_factoid_extractor_panel')) continue;
            const found = cleanCandidate(el.value);
            if (found) return found;
        }
    }
    return '';
}

function findModelInLocalStorage() {
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i) || '';
            if (key.includes(SFE_MODULE_NAME)) continue;
            const raw = localStorage.getItem(key) || '';
            if (!raw || raw.length > 250000 || raw.includes(SFE_MODULE_NAME)) continue;
            let parsed;
            try { parsed = JSON.parse(raw); } catch { continue; }
            const found = findModelInObject(parsed);
            if (found) return found;
        }
    } catch (error) {
        console.debug('[Sage Factoid Extractor] Could not inspect localStorage for API model.', error);
    }
    return '';
}

function findModelInObject(obj) {
    const seen = new WeakSet();
    function walk(node, depth = 0) {
        if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return '';
        seen.add(node);
        for (const [key, value] of Object.entries(node)) {
            if (key === SFE_MODULE_NAME) continue;
            if (MODEL_KEY_RE.test(key)) {
                const found = cleanCandidate(value);
                if (found) return found;
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === SFE_MODULE_NAME) continue;
            const found = walk(value, depth + 1);
            if (found) return found;
        }
        return '';
    }
    return walk(obj);
}

function detectActiveApiProfileModelId() {
    return findModelInKnownSettings() || findModelInDom() || findModelInLocalStorage();
}

function syncExtractorModelWithApiProfile() {
    const modelId = detectActiveApiProfileModelId();
    if (!modelId) return false;

    const context = getContext();
    context.extensionSettings = context.extensionSettings || {};
    context.extensionSettings[SFE_MODULE_NAME] = context.extensionSettings[SFE_MODULE_NAME] || {};
    const settings = context.extensionSettings[SFE_MODULE_NAME];

    if (settings.model === modelId) return true;
    settings.model = modelId;
    context.saveSettingsDebounced?.();

    const input = document.getElementById('sfe_model');
    if (input && input.value !== modelId) input.value = modelId;

    console.info(`[Sage Factoid Extractor] Synced extractor model to API profile Model ID: ${modelId}`);
    return true;
}

function installModelSync() {
    let attempts = 0;
    const tick = () => {
        attempts += 1;
        const ok = syncExtractorModelWithApiProfile();
        if (!ok && attempts < 30) setTimeout(tick, 1000);
    };

    tick();
    setInterval(syncExtractorModelWithApiProfile, 10000);
    document.addEventListener('change', syncExtractorModelWithApiProfile, true);
    document.addEventListener('input', syncExtractorModelWithApiProfile, true);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installModelSync, { once: true });
} else {
    installModelSync();
}
