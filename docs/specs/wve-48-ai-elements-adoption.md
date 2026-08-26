# WVE-48 AI Elements adoption record

Alpha adopts source-owned AI Elements presentation primitives without adding an AI SDK conversation runtime. `AcpTranscript` and the existing controller remain authoritative for transcript order, replay, tool state, plans, permissions, elicitation, usage, and composer actions.

## Adopted components

| AI Elements primitive | Alpha adaptation |
| --- | --- |
| `MessageResponse` | Uses Alpha's existing Streamdown dependency for sanitized streaming Markdown. Optional code, CJK, math, and Mermaid plugins remain disabled. |
| `Reasoning` | Wraps Base UI Collapsible, preserves rich ACP content blocks, keeps a manual disclosure choice stable while streaming, and disables transitions under reduced motion. |
| `PromptInput` | Supplies the compound form, body, textarea, footer, and tools structure beneath the existing flat composer. Attachments and unsupported actions are absent. |
| `Context` | Keeps the compact circular trigger and reveals only ACP-supplied used/max token and cost fields in a keyboard-accessible tooltip. |
| `Tool` | Supplies the disclosure shell while ACP continues to render status, locations, diffs, terminal references, raw data, and failures. |
| `Plan` | Supplies the disclosure shell while ACP statuses and priorities remain unchanged. |
| `Confirmation` | Supplies the permission presentation while preserving every ACP option instead of reducing the protocol to approve/reject. |

The current AI Elements registry does not publish `Question`, so Alpha retains its complete schema-driven and URL-mode elicitation renderer. AI Elements `Attachments` is not adopted because its AI SDK file-part model is narrower than the existing ACP content-block adapters. The existing shadcn `MessageScroller`, `Message`, `Bubble`, `Attachment`, and `Marker` components remain in place.

## Production bundle record

Measurements are from `bun run build` in `product/alpha`. Each row is the output immediately after adding that named component; deltas are relative to the preceding row. Vite's separately emitted `highlighted-body` and `web` chunks remained approximately 0.46 kB and 1.25 kB throughout.

| Stage | Main JS | JS gzip | CSS | CSS gzip | Stage delta, JS / gzip | Stage delta, CSS / gzip |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `HEAD` baseline (`712a7da0`) | 1,213.54 kB | 371.04 kB | 123.11 kB | 19.53 kB | — | — |
| `MessageResponse` | 1,213.78 kB | 371.18 kB | 123.14 kB | 19.55 kB | +0.24 / +0.14 kB | +0.03 / +0.02 kB |
| `Reasoning` | 1,214.69 kB | 371.43 kB | 123.46 kB | 19.57 kB | +0.91 / +0.25 kB | +0.32 / +0.02 kB |
| `PromptInput` | 1,215.70 kB | 371.64 kB | 123.46 kB | 19.57 kB | +1.01 / +0.21 kB | 0 / 0 kB |
| `Context` | 1,216.90 kB | 372.00 kB | 123.69 kB | 19.59 kB | +1.20 / +0.36 kB | +0.23 / +0.02 kB |
| `Tool` | 1,217.19 kB | 372.05 kB | 123.69 kB | 19.59 kB | +0.29 / +0.05 kB | 0 / 0 kB |
| `Plan` | 1,218.41 kB | 372.23 kB | 123.74 kB | 19.59 kB | +1.22 / +0.18 kB | +0.05 / 0 kB |
| `Confirmation` | 1,218.91 kB | 372.32 kB | 123.74 kB | 19.59 kB | +0.50 / +0.09 kB | 0 / 0 kB |
| Composer durability and final hardening | 1,219.49 kB | 372.56 kB | 123.74 kB | 19.59 kB | +0.58 / +0.24 kB | 0 / 0 kB |

The cumulative change is +5.95 kB main JavaScript (+1.52 kB gzip) and +0.63 kB CSS (+0.06 kB gzip). No Alpha dependency or lockfile entry was added for `ai`, Lucide, `tokenlens`, `nanoid`, Shiki, CJK, math, or Mermaid.
