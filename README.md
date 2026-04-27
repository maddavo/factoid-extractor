# Sage Phase 1 Factoid Extractor v0.1.23

## v0.1.23 changes

- Adds `loader.js` as a compatibility loader.
- Updates `manifest.json` so SillyTavern loads `loader.js`, which then imports the existing `index.js` extractor implementation.
- Keeps v0.1.22 extractor logic intact.
- Adds model-ID synchronization support so the extractor attempts to align its stored model setting with the active SillyTavern API connection profile Model ID.
- Reduces the chance of stale extractor model settings after changing LM Studio models or SillyTavern API profiles.
- Logs a browser-console message when the extractor model setting is synchronized, e.g. `Synced extractor model to API profile Model ID: ...`.

## v0.1.23 reason

This update was added after testing with:

```text
rocinante-x-12b-v1-absolute-heresy-i1
```

The model change exposed two environment issues:

1. With `Request JSON response_format` disabled, the model could return prose instead of extractor JSON.
2. Model/profile changes can leave the extractor using a stale manually configured model ID.

v0.1.23 addresses the second issue by trying to inherit/sync the active API profile Model ID when detectable.

For Rocinante-style local models, keep:

```text
Request JSON response_format: on
```

This is a model-compliance setting, not a change to the extractor’s Phase 1 logic.

## v0.1.23 local update steps

From the local extension folder:

```powershell
D:\AI\SillyTavern\public\scripts\extensions\third-party\sage-phase1-factoid-extractor
```

Run:

```powershell
git pull
```

Then:

```text
Restart SillyTavern
Ctrl+F5 in the browser
```

After reload, verify in LM Studio verbose logs that extractor calls show the expected active model ID, for example:

```json
"model": "rocinante-x-12b-v1-absolute-heresy-i1"
```

# Sage Phase 1 Factoid Extractor v0.1.22

## v0.1.22 changes

- Reworks the extension panel for operator review during formal testing.
- Adds a compact header/status strip.
- Keeps **Operator review** open by default with Apply/Reject buttons directly above the comparison area.
- Shows **Next pending proposed packet changes** and **Rendered OOC packet preview** as paired review panes.
- Moves queue/raw JSON/state into a collapsed diagnostics section.
- Moves cleanup/export/reset controls into a collapsed utilities section.
- Moves configuration into a collapsed, grouped settings section.
- Retains all v0.1.21 participant/body-state scene reconciliation behaviour.

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
- Can merge identical generic same-location objects, such as duplicate bottles/cups/glasses/papers, while avoiding unique/personal/named objects.
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
Model: active SillyTavern API profile Model ID where detectable; otherwise your loaded LM Studio model name
API key: blank
Request JSON response_format: on for Rocinante-style local models; otherwise off/on according to model compliance
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
