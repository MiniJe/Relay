# Operator workflow research prototype

Non-production A8 evidence for [RLY-UX-R-001](../../RESEARCH-OPERATOR-UX.md). No Relay API calls, persistence changes, credentials, provider traffic or production assets.

## Run

Open `index.html` directly, or from the repository root:

```sh
node docs/prototypes/operator-workflow/serve.mjs
```

Browse `http://127.0.0.1:4388`. `PORT` can override the port. The server binds loopback and serves only the three prototype assets. Ctrl+C stops it.

## Walkthrough

1. Start with Checkout selected. Acknowledge, then Create incident and accept the visible defaults.
2. Inspect commander, provider receipt and public state; complete a task and add an internal note.
3. Draft a public update. Enter a customer-safe title and message; review the exact audience/component/state/text, then publish.
4. Before step 3, enable **Simulate publish failure** to exercise failure. Cancel review, disable the switch, reopen the preserved draft and retry.
5. Resolve internal response with evidence. Public state deliberately remains separate; explicitly draft/publish a recovery update if desired.
6. Save a post-incident review owner, date and follow-up.
7. Switch volumes for 5, 50 and 500 alerts. Search ALT-499, page through, filter and acknowledge only selected rows.

Changing volume or reloading resets everything. Fixed fixture times do not measure response speed. “Published” updates only the local customer projection. Grouping annotates selected objects; suppression expiry is simulated through **End suppression**. The single-incident model is intentionally limited. See report for additional limits and current-Relay/prototype semantic differences.

## Reproduce browser evidence

The runner uses the existing Relay test harness in memory, mocks transports, seeds fictional data and closes both servers/browser. It captures the current UI at two widths and tests the prototype. It is not A3 release qualification. Install Relay's locked dependencies with `npm ci`; supply Playwright externally without changing Relay dependencies.

```sh
node docs/prototypes/operator-workflow/verify.mjs
```

On the research host, Playwright was loaded through `NODE_PATH` pointing to the bundled Codex runtime's `node_modules`, and `RELAY_BROWSER_CHANNEL=msedge` selected installed Edge. Elsewhere, resolve Playwright normally and use an installed Chromium, or set that channel variable appropriately. No browser binaries or machine-specific runtime paths are committed.

Results and viewport screenshots are in `evidence/`. All screenshots are generated from fictional fixtures. The JSON lists measured table positions, horizontal containment, simple unlabelled-control counts and prototype assertions. None of these substitute for a real screen-reader or human usability study.
