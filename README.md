# Sage Phase 1 Factoid Extractor

A review-first SillyTavern UI extension for the Sage continuity project.

It watches live chat events, calls a local OpenAI-compatible extractor endpoint, and proposes sparse Phase 1 continuity deltas for:

- `CurrentScene`
- `RecentEvents`

It does **not** redesign the Sage card or preset. It does **not** build Data Bank or persistent long-term memory. It is intended to test whether factoids can be extracted from live chat with low enough operator burden to continue the project.

## Default behaviour

- Auto-runs after assistant replies.
- Sends recent chat turns plus previous applied Phase 1 state to an extractor model.
- Stores proposed JSON deltas in the current chat metadata.
- Does not auto-apply deltas unless you enable `Auto-apply proposed deltas`.
- Provides buttons to apply/reject proposals, export audit JSON, and export a controller Markdown report.

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
Endpoint: http://localhost:1234/v1/chat/completions
Model: local-model
API key: blank
Temperature: 0
Recent messages: 10
Max output tokens: 900
Request JSON response_format: on
Auto-apply proposed deltas: off
```

In LM Studio, start the local server and load the model you want to test as the extractor.

If the browser console reports a CORS error, the extension cannot reach LM Studio directly from the browser. In that case, use a server-side proxy or adapt the extension to call SillyTavern's own quiet generation pathway in a follow-up branch.

## Viability test workflow

1. Enable the extension.
2. Leave `Auto-apply proposed deltas` off.
3. Chat normally in the Sage test chat.
4. After each assistant reply, inspect `Latest extractor output`.
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
- Did it output usable JSON?

## Important limitation

This is a live extraction test harness, not a final continuity system. A viability conclusion should only be written after running it against real Sage chats and reviewing the exported proposals.
