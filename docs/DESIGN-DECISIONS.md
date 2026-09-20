# Relay interface design decisions — Quiet Operations

This document records the design direction used for the RLY-UX corrective work. The goal is a calm operational interface: dense enough to work quickly, explicit about state, and visually quiet enough that incidents—not decoration—receive attention.

## Reference map

| Reference | Observed pattern | Relay decision | Rejected alternative |
| --- | --- | --- | --- |
| Linear UI redesign — https://linear.app/now/how-we-redesigned-the-linear-ui | Aligned sidebar/header/panels, higher information density, reduced visual noise | Use a fixed-width operational sidebar, a compact top bar, aligned content columns, thin separators, and restrained surfaces | Large marketing hero areas, floating glass cards, decorative KPI walls |
| incident.io Status Pages / publishing workflow — https://incident.io/status-pages and https://docs.incident.io/status-pages/publishing-incidents | Public communication is part of incident handling and publication is a deliberate review step | Keep internal notes as the default; public updates enter a review dialog showing message, affected scope and destination pages before an explicit **Publish public update** action | A generic “Publish update” button that can accidentally send internal drafting publicly |
| IBM Carbon data-table usage — https://carbondesignsystem.com/components/data-table/usage/ | Operational collections benefit from aligned rows, predictable columns and contextual controls | Incidents, components and Playground services use tables/rows before cards; row height and metadata remain compact | One oversized card per record |
| IBM Carbon status indicators — https://carbondesignsystem.com/patterns/status-indicator-pattern/ | Status needs consistent labels and should not rely on color alone | Every state has a text label plus icon/shape treatment; severity, lifecycle and availability use separate visual treatments | Glowing green/red orbs as the only meaning carrier |
| Atlassian incident communication — https://www.atlassian.com/incident-management/tutorials/incident-communication | Customer-facing incident communication is distinct from internal coordination | Public updates are clearly separated from internal notes; the public page shows only public data and customer impact | Mixing responder notes and customer updates in a single undifferentiated composer |
| W3C WCAG 2.2 — https://www.w3.org/TR/WCAG22/ | Meaning cannot depend only on color; text must remain readable and usable at 200% zoom | Visible focus rings, semantic labels/headings/tables, text status labels, AA-oriented contrast, reduced-motion support and responsive layouts | Color-only health, tiny metadata, focusless custom controls, motion-heavy feedback |

## Visual system

- System UI stack with Segoe UI on Windows; no runtime web-font dependency.
- Base application text: 14px; public page body: 16px; metadata never below 12px.
- Spacing tokens: 4, 8, 12, 16, 24, 32px.
- Sidebar target: 232px. Top bar: 54px.
- Controls: 7px radius. Panels/dialogs: 10px radius.
- Light theme uses white/off-white neutral surfaces. Dark theme uses neutral graphite surfaces without purple tint.
- Blue is the only interaction accent. Green/amber/orange/red communicate availability/severity states and always include readable labels.
- Shadows are reserved for overlays/dialogs. Working surfaces use borders and hierarchy instead.
- Motion is short feedback only and disabled under `prefers-reduced-motion: reduce`.

## Information hierarchy

### Operator application

1. Active incidents and customer impact.
2. Effective component impact, explicitly separated from configured component state.
3. Incident response workspace and timeline.
4. Service/component/status-page configuration.
5. Integrations/settings.

The overview uses a compact summary strip and incident table rather than four promotional metric cards.

### Incident workspace

The incident header carries title, severity, lifecycle and actions. The primary column contains summary, response controls, update composer and update history. The secondary column contains ownership, affected scope and timeline. On narrow screens the context column stacks below the working area.

Public publication is intentionally two-step: compose -> review destination/scope -> explicit publish.

### Public status page

A single readable column presents current status, active customer-impacting incidents, components and recorded incident history. Unsupported uptime percentages, synthetic charts, subscriber counts and ETAs are omitted.

### Playground

The Playground remains visibly separate and is labeled **Local simulation**. Desired fault, detector observation, Relay publication and associated incident are distinct columns/states. Controls operate only on synthetic services.

## Interaction decisions

- Theme follows the OS by default; explicit user choice is retained locally.
- Background updates never intentionally clear an unsent incident-update draft.
- Missing/stale data is shown as unavailable/stale rather than silently represented as healthy.
- Modal dialogs restore focus to the invoking control and support Escape/keyboard traversal.
- Responsive tables convert to stacked labeled rows on narrow screens rather than forcing page-level horizontal overflow.
