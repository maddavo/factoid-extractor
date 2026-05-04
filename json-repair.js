// Local-model JSON parsing and near-JSON repair helpers.

export function parseJsonContent(content) {
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
    // Tolerate accidental doubled colons after a quoted key, e.g. "name":: "Special Punch".
    s = s.replace(/("[A-Za-z_][A-Za-z0-9_\-]*")\s*::\s*/g, '$1: ');
    // Tolerate Markdown-emphasised keys from local models, e.g. *importance_score*: 4 or **key**: value.
    s = s.replace(/([{,]\s*)\*\*([A-Za-z_][A-Za-z0-9_\-]*)\*\*\s*:/g, '$1\"$2\":');
    s = s.replace(/([{,]\s*)\*([A-Za-z_][A-Za-z0-9_\-]*)\*\s*:/g, '$1\"$2\":');
    s = s.replace(/([{,]\s*)\"\*\*?([A-Za-z_][A-Za-z0-9_\-]*)\*?\*\"\s*:/g, '$1\"$2\":');
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


