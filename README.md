# Sage Phase 1 Factoid Extractor v0.1.17

Review-first SillyTavern UI extension for testing live Phase 1 factoid extraction in the Sage continuity project.

It proposes sparse deltas for:

- `CurrentScene`
- `RecentEvents`

It does not redesign the Sage card/preset, build Data Bank, or implement persistent long-term memory.

## v0.1.17 changes

- Allows durable relationship/role/status designations through the strict RecentEvents gate.
- Treats explicit ongoing labels such as `master`, `mistress`, `dominant`, `submissive`, `owner`, or equivalent role/status language as high-salience RecentEvents when the chat frames them as persistent.
- Keeps rejecting temporary body-position/contact/intensity narration as surroundings or RecentEvents.
- Adds high-salience cue detection for those relationship/role terms, so the extractor can trigger before the periodic interval.
- Retains v0.1.16 surroundings filtering.

## v0.1.16 retained behaviour

- Adds visible version display.
- Adds `Surroundings update mode` setting.
- Default mode: `Location/sub-location/environment only`.
- Suppresses `surroundings_summary` updates caused by body position, sexual blocking, touch/grab/kiss/body placement, intensity, mood, tempo, or decorative narration.
- Allows `surroundings_summary` updates when `location_ref` changes, sub-location changes, or stable practical environmental anchors change, such as door locked/open/closed, lights on/off, shower running, bed broken, room flooded, alarm/smoke/fire, window open/closed.

## Recommended formal-test settings

```text
Endpoint: /proxy/http://127.0.0.1:1234/v1/chat/completions
Model: local-model or your loaded LM Studio model name
API key: blank
Request JSON response_format: off
Trigger: After assistant reply
Auto-run policy: Periodic or scene/event cue
Every N user messages: 10
Scene cue prefilter: on
High-salience event cue prefilter: on
Recent messages: 10
Max output tokens: 1200
Strict RecentEvents gate: on
Min event importance: 4
Max events/proposal: 1
Expire old room objects on location change: on
Surroundings update mode: Location/sub-location/environment only
Auto-apply proposed deltas: off
```

## Install

Replace the existing `sage-phase1-factoid-extractor` folder, restart SillyTavern, then reload the browser with Ctrl+F5.
