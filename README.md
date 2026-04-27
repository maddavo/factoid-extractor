# Sage Phase 1 Factoid Extractor v0.1.21

## v0.1.21 changes

- Adds scene reconciliation for long/complex physical scenes.
- Suppresses participants/characters being stored as nearby objects, e.g. `The couch: Davo`.
- Suppresses transient body-position/contact/blocking object facts such as sitting next to, moving toward, in someone’s grasp, or being touched.
- Adds **Scene reconciliation mode** and **Reconcile current scene** button.
- Tightens RecentEvents so social/sexual colour or transient escalation is rejected unless it creates a durable relationship/status/protocol fact or unresolved practical consequence.
- Retains all v0.1.20 conservative object coalescing.

# Sage Phase 1 Factoid Extractor v0.1.20

## v0.1.20 changes

- Adds conservative object coalescing.
- Combines interchangeable same-location cash items into one total, e.g. `$40 cash`.
- Can merge identical generic same-location items, such as duplicate bottles/cups/glasses/papers, while avoiding unique/personal/named items.
- Adds an **Object coalescing mode** setting and **Coalesce current objects** button.
- Retains all v0.1.19 JSON repair and split-scene handling.

# Sage Phase 1 Factoid Extractor v0.1.19

## v0.1.19 changes

- Repairs a local-model near-JSON error where a property key is emitted with a double colon, e.g. `"name":: "Special Punch"`.
- Adds extractor prompt wording prohibiting doubled JSON colons.
- Retains all v0.1.18 split-location/remote-communication handling.

# Sage Phase 1 Factoid Extractor v0.1.18

Review-first SillyTavern UI extension for testing live Phase 1 factoid extraction in the Sage continuity project.

It proposes sparse deltas for:

- `CurrentScene`
- `RecentEvents`

It does not redesign the Sage card/preset, build Data Bank, or implement persistent long-term memory.

## v0.1.18 changes

- Adds split-location / remote communication handling for cases where Davo and Sage are no longer physically co-present but continue interacting by text/phone/call.
- Adds `Remote/split-scene cue prefilter` so the extractor can trigger on texting/phone plus separated-location cues before the periodic interval.
- Updates extractor instructions to render split scenes without implying physical co-presence.
- Preferred split-scene packet form: `Split scene: Davo in HOTs kitchen; Sage in Exam Hall`, plus qualified entity lines such as `Davo — local, HOTs kitchen` and `Sage Morgan-Burke — remote, Exam Hall, texting by phone`.
- Allows remote/texting surroundings summaries even in location-only surroundings mode.
- Keeps v0.1.17 durable relationship/role/status gate behaviour.

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
