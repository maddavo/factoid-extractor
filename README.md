# Sage Phase 1 Factoid Extractor

A review-first SillyTavern UI extension for the Sage continuity project.

It watches live chat events, calls a local OpenAI-compatible extractor endpoint, and proposes sparse Phase 1 continuity deltas for:

- `CurrentScene`
- `RecentEvents`

It does **not** redesign the Sage card or preset. It does **not** build Data Bank or persistent long-term memory. It is intended to test whether factoids can be extracted from live chat with low enough operator burden to continue the project.

## Default behaviour

- Auto-runs after assistant replies.
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
Max output tokens: 900
Request JSON response_format: off for first test
Auto-apply proposed deltas: off
```

In LM Studio, start the local server and load the model you want to test as the extractor.

This build defaults to the SillyTavern CORS proxy path. In `config.yaml`, set `enableCorsProxy: true`, then restart SillyTavern.

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
