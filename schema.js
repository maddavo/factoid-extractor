// LM Studio/OpenAI-compatible JSON schema response_format builder.

export function buildLmStudioJsonSchemaResponseFormat() {
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
