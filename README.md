# Sage Phase 1 Factoid Extractor v0.1.15

A review-first SillyTavern UI extension for the Sage continuity project.

It watches live chat events, calls a local OpenAI-compatible extractor endpoint, and proposes sparse Phase 1 continuity deltas for:

- `CurrentScene`
- `RecentEvents`

It does **not** redesign the Sage card or preset. It does **not** build Data Bank or persistent long-term memory. It is intended to test whether factoids can be extracted from live chat with low enough operator burden to continue the project.

## v0.1.15 fix

- Filters no-op scene proposals before review. If an object/entity/location/surroundings value is already applied, it no longer appears as an ADD/UPDATE line.
- Drops contradictory same-object add/remove proposals in one extractor result. Explicit presence/update is treated as evidence not to remove it, but if the update is also a no-op then both lines disappear from the operator review.

## Default behaviour

- Auto-runs according to the selected policy. Default: periodic every 10 user messages or immediately on scene cue/marker.
- Sends recent chat turns plus previous applied Phase 1 state to an extractor model.
- Stores proposed JSON deltas in the current chat metadata and displays a plain-English review summary first.
- Does not auto-apply deltas unless you enable `Auto-apply proposed deltas`.
- Provides buttons to apply/reject proposals, copy the readable review summary, export audit JSON, and export a controller Markdown report.

## Installation

Copy the folder:

```text
sage-phase1-factoid-extractor
```

into your SillyTavern third-party extension folder. Common development location:

```text
<SillyTavern>/public/scripts/extensions/third-party/sage-phase1-factoid-extractor
```

Then reload SillyTavern and enable the extension from the Extensions panel.

If your SillyTavern install uses the newer per-user extension location, copy the folder into:

```text
<SillyTavern>/data/<your-user-handle>/extensions/sage-phase1-factoid-extractor
```

## LM Studio setup

Recommended first test settings:

```text
Endpoint: /proxy/http://127.0.0.1:1234/v1/chat/completions
Model: local-model
API key: blank
Temperature: 0
Recent messages: 10
Max output tokens: 1200
Request JSON response_format: off for first test
Auto-run policy: Periodic or scene cue
Every N user messages: 10
Scene cue prefilter: on
Auto-apply proposed deltas: off
Expire old room objects on location change: on
```

In LM Studio, start the local server and load the model you want to test as the extractor.

This build defaults to the SillyTavern CORS proxy path. In `config.yaml`, set `enableCorsProxy: true`, then restart SillyTavern.

## v0.1.15 pending queue fix

- The review panel now shows the **next pending proposal** rather than an arbitrary latest entry.
- Pending proposals are applied/rejected oldest-first by turn count.
- A visible Pending Proposal Queue shows all waiting proposals.
- Stale scene updates are guarded: an older pending proposal cannot overwrite a newer applied `location_ref`, `surroundings_summary`, or object state.

## Viability test workflow

1. Enable the extension.
2. Leave `Auto-apply proposed deltas` off.
3. Chat normally in the Sage test chat.
4. After each assistant reply, inspect `Latest proposed packet changes`.
5. Apply only good proposals.
6. Reject wrong, ambiguous, or bloated proposals.
7. At the end of a test run, click:
   - `Export audit JSON`
   - `Export controller MD`
8. Send both files back to the controller.

## What to evaluate

For each proposed delta, judge:

- Was it sparse?
- Was it directly supported by the chat turns?
- Did it avoid banter and mood?
- Did it preserve actor/object names?
- Did it avoid pronouns in stored facts?
- Did it update stale object locations when objects moved?
- Did it flag or avoid ambiguity?
- Did it avoid decorative assistant-invented details?
- Did the readable proposal summary make the operator decision easy?
- Did it still export usable audit JSON?

## Important limitation

This is a live extraction test harness, not a final continuity system. A viability conclusion should only be written after running it against real Sage chats and reviewing the exported proposals.

## v0.1.3 / Extension v04 fix

- Fixed object-removal proposals where the extractor returned an object instead of a string.
- The review panel now converts object-form removal targets to the object name instead of showing `[object Object]`.
- Applying a removal now correctly removes the stored nearby object when the target is supplied as `{ "name": "..." }` or similar.
- The extractor prompt now explicitly asks for `nearby_objects_remove` as string-only object names.


## v0.1.4 / Extension v05 fix

- Changed the rendered OOC scene packet to group nearby objects by location.
- Example: `- Cafeteria table: Sage's coffee, Muffin plate` instead of one line per object.
- Changed the human-readable proposal summary to group proposed object updates by location.
- Object-removal proposal lines now show the current known location when available, e.g. `- REMOVE Cafeteria table: Sage's coffee`.
- Internal state is still object-centric (`name` + `location`) so movement and removal remain reliable; only the packet/review rendering changed.


## v0.1.5 / Extension v06 fix

- Tightened RecentEvents extraction.
- RecentEvents are now treated as rare unresolved practical reminders, not ordinary chat progress.
- Added strict local post-filtering before proposals reach the Apply button.
- Default event threshold: importance score 4+ only.
- Default cap: maximum 1 new RecentEvent per extraction pass.
- Drops event candidates with no causal result, no evidence, weak emotional/banter/dialogue cues, or low importance.
- Scene/object extraction and grouped object-location packet rendering are unchanged.
- Added UI controls: `Strict RecentEvents gate`, `Min event importance`, and `Max events/proposal`.


## v0.1.6 changes

- Adds tolerant near-JSON repair for common local-model output errors such as trailing commas.
- Saves raw extractor text after a parse failure for debugging.
- Tightens RecentEvents rendering so old low-importance events are hidden from packet preview when strict gating is enabled.
- Adds a `Prune weak RecentEvents` button to remove already-stored weak events from this chat's metadata.

## v0.1.10 / Extension v10 changes

- Adds throttled extraction so the extractor no longer runs after every assistant reply by default.
- New default policy: `Periodic or scene cue`.
- New default periodic interval: every 10 user messages.
- Adds a scene-change cue prefilter for common location-change wording such as enter/leave/return/arrive/go to/walk into.
- Adds explicit scene marker detection using a configurable regex. Default markers include:
  - `<!--SAP_SCENE_CHANGE-->`
  - `<sap_scene_change/>`
  - `[[SAP_SCENE_CHANGE]]`
- Adds skipped-run accounting in the panel so the operator can see when auto-extraction was deliberately deferred.
- Manual `Run extraction now` still always runs.

Recommended test policy for latency reduction:

```text
Auto-run policy: Periodic or scene cue
Every N user messages: 10
Scene cue prefilter: on
Trigger: After assistant reply
Auto-apply: off
```

If scene cues cause too many extractor calls, switch to:

```text
Auto-run policy: Periodic or explicit marker only
```


## v0.1.15 throttle UI

This build exposes the throttle controls in the panel:

- Version badge in the panel title and counts/status row.
- Auto-run policy.
- Every N user messages.
- Scene cue prefilter checkbox.
- Scene marker regex.

Default recommended policy:

```text
Auto-run policy: Periodic or scene cue
Every N user messages: 10
Scene cue prefilter: on
```


## v0.1.15 note

When the applied location changes, old room-local nearby objects are expired unless the extractor explicitly re-adds them in the new scene. This prevents generic anchors such as "The floor" from following the chat into a new room. A manual "Clear nearby objects" button is also available for cleaning already-contaminated state.


## v0.1.15 notes

- Adds high-salience event cue prefilter for relationship/commitment/status changes.
- Allows explicit girlfriend/boyfriend/partner relationship status changes through the strict RecentEvents gate as importance 5 facts.
- Auto-run policy label now reflects scene/event cue triggering.
