// Sage Phase 1 Factoid Extractor shared constants
// v0.1.27 — coalesce RecentEvents and guard extractor context budget.

export const EXTENSION_VERSION = '0.1.27';

export const MODULE_NAME = 'sage_phase1_factoid_extractor';
export const MODULE_TITLE = 'Sage Phase 1 Factoid Extractor';

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    autoRun: true,
    trigger: 'assistant', // assistant | user_and_assistant
    autoRunPolicy: 'periodic_or_scene_cue', // always | periodic_only | periodic_or_marker | periodic_or_scene_cue
    periodicUserMessages: 10,
    sceneCuePrefilter: true,
    highSalienceEventCuePrefilter: true,
    remoteCommunicationCuePrefilter: true,
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
    recentEventsCoalescingMode: 'conservative', // conservative | off
    maxPreviousRecentEventsForPayload: 4,
    maxInputCharsPerTurn: 900,
    maxExtractorPayloadChars: 14000,
    clearRoomObjectsOnLocationChange: true,
    surroundingsUpdateMode: 'location_only', // location_only | normal
    objectCoalescingMode: 'conservative', // conservative | off
    sceneReconciliationMode: 'suppress_participant_blocking', // suppress_participant_blocking | off
    debug: false
});

export const EMPTY_SCENE = Object.freeze({
    location_ref: '',
    present_entities: [],
    nearby_objects: [],
    surroundings_summary: '',
    last_updated_turn: 0
});

