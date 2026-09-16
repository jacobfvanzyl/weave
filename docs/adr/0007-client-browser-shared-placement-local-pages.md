---
status: accepted
date: 2026-09-16
---

# Share Client Browser placement while keeping pages local

Use **Host Browser** for the existing Host-owned browser and **Client Browser** for native WebKit browsing on each Apple client. A Client Browser Pane belongs to an existing Host-owned Workspace, sharing only identity, placement and initial address; each device owns its live page, navigation and profiles. This preserves Workspace composition while allowing independent browsing and sign-ins on Mac and iPad.

Composition schema 4 migrates the old `browser` discriminator to `host-browser` without changing content or layout identities and adds `client-browser`. Protocol 9 requires matching clients and Hosts. Established `browser.*` RPC names continue to address only the Host Browser; Client Browser lifecycle RPCs use `client-browser.pane.*` and never invoke a Host browser backend.

Shared close requires confirmation because the Host cannot inspect local forms or activity. Clients checkpoint their own address/profile and close only after explicit membership reconciliation; a disconnected or filtered composition is not evidence of removal. Native reattachment uses Host and Pane identity, so changing Workspace or React presentation does not recreate the page. Popup transactions are adopted on their originating device; other devices receive a blank initial address and never replay the transaction.
