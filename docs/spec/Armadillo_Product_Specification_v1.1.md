# Armadillo — Product Specification v1.1

**Status:** Planning only — no code or website changes  
**Product:** Armadillo, a cybersecurity hardening control panel  
**Release target:** Version 1.0

## 1. Product Overview

Armadillo is a **private cybersecurity hardening workspace with a public pastebin**, built around individual system-hardening sessions. It combines:

- A Claude-powered assistant for adapting and improving hardening scripts.
- A private library of reusable Windows, Windows Server, Linux, and LEADS/audit scripts.
- A publicly accessible pastebin for explicitly published code and text.
- An interactive hardening flowchart with saved progress.
- Session-based handling of READMEs, scripts, LEADS results, and verification evidence.

The interface should resemble a professional cybersecurity operations console: compact, organized, technical, and efficient.

**Core product principle:** Everything needed for one hardening image stays together. Users should not have to repeatedly provide the same README, explain which OS they are using, or search unrelated conversations for a current script.

## 2. Confirmed Design Decisions

| Area | Direction |
|---|---|
| Access | Private user workspace, publicly accessible pastebin |
| Script execution | Download scripts, execute locally, upload results |
| Flowchart | Interactive with saved progress |
| AI engine | Claude via API |
| Script library | Completely empty on first launch |
| Supported systems | Windows, Windows Server, Linux |
| Primary workflow | README → Claude → Hardening → LEADS → Claude → Verification |
| Visual style | Flat dark UI, muted-green accent, compact panels |
| Navigation | Persistent sidebar with central workspace tabs |

## 3. Visual Design and Navigation

### 3.1 Design Language

- **Style:** Flat, dark security operations control panel.
- **Main background:** `#111713`.
- **Surface:** `#1C2520`.
- **Primary accent:** `#A8D477` (muted green).
- **Primary text:** `#F0F4EF`.
- **Typography:** Geist or Inter for the UI; JetBrains Mono for code and terminal-style output.
- **Typography scale:** Approximately 32 px main headings, 16 px body text.
- **Spacing scale:** 4, 8, 16, and 24 px.
- **Iconography:** Consistent Lucide icons.

Avoid default purple/blue gradients, glow effects, glassy overlays, excessive status badges, decorative SVG lines, and oversized cards. Interactive elements must have clear hover, focus, empty, loading, and error states.

### 3.2 Main Layout

Three-part layout:

1. **Persistent left sidebar:** Primary navigation.
2. **Large central workspace:** Tabs for Claude, README files, scripts, flowchart, and reports.
3. **Optional right inspector:** Contextual information, requirements, file details, or status.

Tabs should behave similarly to an editor: opening a library script or README does not close the Claude conversation. Users can compare resources while working in the same session.

### 3.3 Main Pages

| Page | Purpose |
|---|---|
| Dashboard | Recent sessions, workflow stages, and quick actions |
| Claude Workspace | README analysis, script adaptation, and remediation assistance |
| Script Library | Store, search, edit, download, and version reusable scripts |
| Public Pastebin | Publish, search, copy, and share explicitly public scripts/text |
| Hardening Flowchart | Interactive process steps, completion status, and links to tools |
| Sessions & Reports | View LEADS results, remediation history, and verification evidence |
| Settings | Account preferences, Claude API setup, privacy, and application options |

## 4. Hardening Sessions

A **Hardening Session** represents one target system image being hardened. Every session can contain:

- Session title and operating-system type.
- Uploaded or pasted README.
- Selected universal hardening and LEADS scripts.
- Adapted or generated script versions.
- Claude conversation and analysis context.
- Forensic-question progress.
- Uploaded LEADS audit reports.
- Remediation history and repeated audit cycles.
- Flowchart/checklist progress and final verification evidence.

Example session: `Windows Server 2022 — Round 2`.

Creating a new session must **not** clear the universal script library. Universal scripts are independent of sessions; per-session adaptations are stored as separate versions or copies.

The Dashboard should show recent sessions, current stages, and resume actions. A fresh installation should have meaningful empty states, not fictitious sample activity.

## 5. Claude Workspace

Claude is a context-aware hardening assistant integrated with the current session and explicitly selected resources, not just a standalone chatbot.

### 5.1 Script Adaptation Mode

**Inputs:**

- A pasted README or uploaded `.txt`, `.md`, or `.pdf` document.
- A script chosen from the universal library.
- Operating-system and session context.

**Process:**

1. Read the applicable README requirements.
2. Compare them with the selected existing script.
3. Identify covered requirements and gaps.
4. Propose modifications, including warnings about disruptive actions.
5. Show a side-by-side diff of the original and adapted scripts.
6. Allow the user to accept or reject changes.
7. Save the adapted script as a new version or session-specific copy.
8. Allow the approved script to be downloaded for local execution.

The universal source script should never be silently overwritten.

### 5.2 LEADS Remediation Mode

**Inputs:** Latest uploaded LEADS report and relevant session context.

**Process:**

1. Analyze report findings.
2. Group issues by category or severity where the report supports it.
3. Identify missing or incomplete requirements.
4. Propose targeted remediation rather than blindly re-running an entire script.
5. Display changes for review and approval.
6. Produce a downloadable remediation script.
7. Await a subsequent user-uploaded audit report for verification.

### 5.3 Requirements Matrix

Each README requirement should have a record that includes its source location (paragraph or PDF page) and status.

| Finding | Expected handling |
|---|---|
| Requirement detected | Link to source passage/page |
| Already handled in selected script | Mark covered, pending verification |
| Missing from selected script | Suggest a modification |
| Potentially disruptive | Require explicit review |
| Not safely automatable | Create a manual task |
| Verified by later evidence | Mark complete |

**Important distinction:** Claude's assessment of a script is not proof that the target machine is hardened. The app must distinguish **proposed**, **implemented/reported**, and **verified** work.

### 5.4 High-Impact Changes

Explicitly flag operations that modify user accounts, disable services, edit firewall rules, change remote-access settings, or otherwise risk interrupting access to the machine.

## 6. Script Library

The library starts **completely empty**: no default scripts, sample content, or fake records. Its initial state should say something like **“No scripts in your library”**, with actions to upload a file or create a script.

### 6.1 Library Categories

- Windows.
- Windows Server.
- Linux.
- LEADS / Audit.

Scripts may also be classified by function:

- Universal Hardening.
- LEADS / Audit.
- Session-Generated.

### 6.2 Supported Features

- Upload, create, edit, search, filter, copy, and download.
- Syntax highlighting for PowerShell and Bash, plus other supported text-based scripts.
- File types including `.ps1`, `.sh`, `.bat`, `.cmd`, `.txt`, and `.md`.
- Version history and change comparison.
- Metadata: operating-system compatibility, description, filename, version, and modification history.
- Select a script as Claude context.
- Separate reusable universal versions from session-specific adaptations.

PDFs are inputs for instructions and reports, not directly editable script files.

## 7. Public Pastebin

Pastebin is public-facing, but publishing is **always an explicit user action**. Private READMEs, sessions, reports, and generated scripts must never be published automatically.

### 7.1 Features

- Create and publish text or scripts.
- Search and filter public pastes.
- Syntax highlighting and raw text view.
- Copy and download.
- Shareable links.
- Optional expiration.
- Edit or delete owned pastes.
- Unlisted pastes accessible via direct URLs rather than public search.

### 7.2 Safety and Privacy

- Secret-detection warning before publishing.
- Confirmation before publishing material from private workspace resources.
- Content sanitization, abuse reports, and rate limits.
- Access and ownership checks for editing/deletion.
- Public paste data stored separately from private library and session data.

The public pastebin should share the same editor/search conventions as the private library while remaining a distinct datastore and permission boundary.

## 8. Interactive Hardening Flowchart

The supplied flowchart is the authoritative starting point. In Armadillo, its nodes should be interactive and associated with session resources.

### 8.1 Workflow Steps

1. **Open README:** Attach source instructions and record the system type.
2. **Forensic questions and Claude adaptation:** Track forensic questions separately while Claude prepares the initial script.
3. **Run hardening script:** Download the reviewed script, run it locally, and record/upload execution results.
4. **Run LEADS:** Execute the matching audit script and upload its output.
5. **Inspect LEADS report:** Review findings and send the report to Claude.
6. **Run targeted remediation:** Review, download, and execute follow-up fixes locally.
7. **Check final point count:** Record verified results and decide whether another audit cycle is required.
8. **Submit final:** Finish the session and preserve final evidence.

### 8.2 Node Interaction

Each node should support:

- Status: **Not Started**, **In Progress**, **Complete and Verified**, or **Blocked/Needs Review**.
- Notes and associated evidence.
- A direct action to open its relevant Armadillo tool in the main workspace.
- Persistent progress per session.
- History of previous audit/remediation cycles.

Clicking a step such as **Send LEADS Report to Claude** should open the Claude tab with the relevant report attached or selected.

### 8.3 Unresolved Flowchart Logic

The supplied flowchart uses `If =100` for submission and `If >100` for the return loop. The precise scoring/branch conditions need confirmation before they are implemented as decision logic. Until then, represent the branch conceptually as **Completion condition** versus **Continue remediation**.

The forensic-question branch should also be clearly linked to the main sequence, while retaining its separately tracked completion state.

## 9. Script Execution Boundary

Armadillo Version 1.0 does **not** execute arbitrary PowerShell or Bash code on the user's machine from the browser.

Instead:

1. User reviews and downloads an approved script.
2. User executes it locally on the target environment.
3. User uploads available execution and/or audit output.
4. Armadillo analyzes the report and maintains its record.

A connected desktop execution agent and automatic scoring may be considered in a later version, subject to technical feasibility and additional security controls.

## 10. Security and Reliability Requirements

| Requirement | Expected behavior |
|---|---|
| Authentication | Private workspace requires login |
| Claude credentials | API keys remain server-side and are never exposed to browsers |
| File isolation | Only authorized users can access private session files |
| AI context controls | Claude receives only explicitly selected session resources |
| Script preservation | Immutable originals and recoverable version history |
| Execution boundary | No browser-triggered local script execution in v1 |
| Audit accuracy | Do not label a machine secure without verification evidence |
| Public publishing | Explicit opt-in, content screening, ownership enforcement |
| Failures | Recoverable uploads and AI requests without silently losing work |
| Activity tracking | Important actions and file/version changes are recorded |

Uploaded READMEs, reports, and pasted content must be treated as untrusted data. They should not be able to override application instructions or access unrelated private resources.

## 11. Suggested Data Model

The application should maintain separate entities for:

- Users.
- Hardening sessions.
- Script library items.
- Script versions and session-generated copies.
- Source READMEs.
- Claude conversations.
- README requirements and their coverage/verification statuses.
- LEADS audit reports.
- Remediation and workflow-step history.
- Public and unlisted pastes.

Relationships among these resources should be defined early so session context, audit provenance, and script history remain reliable.

## 12. Version 1.0 Scope

| Feature | First release |
|---|---|
| Dark control-panel UI | Yes |
| Dashboard and tabbed workspace | Yes |
| Claude chat with real API integration | Yes |
| README paste and PDF upload | Yes |
| Empty-on-first-launch script library | Yes |
| Script editor and version history | Yes |
| Public pastebin and search | Yes |
| Interactive hardening checklist/flowchart | Yes |
| LEADS report uploads and analysis | Yes |
| Automated execution on user machines | Later |
| Automatic score retrieval | Later, if a supported source exists |
| Multiuser/team collaboration | Later |

## 13. Development Milestones

| Milestone | Deliverable |
|---|---|
| 1. Foundation | Authentication, design system, dashboard, tabs, database structure |
| 2. Resources | Empty script library, file uploads, editing, and version history |
| 3. AI | Claude integration, README analysis, requirements matrix, script differences |
| 4. Workflow | Interactive flowchart, sessions, LEADS reports, remediation history |
| 5. Publishing & QA | Public pastebin, search, security protections, error handling, testing |

### 13.1 Minimum End-to-End Acceptance Test

Version 1.0 is ready when a user can:

1. Create a new hardening session.
2. Upload or paste a README.
3. Select a previously uploaded universal script.
4. Ask Claude to adapt the script to the README.
5. Review the requirements matrix and proposed code changes.
6. Save and download the approved adaptation.
7. Execute the script locally and upload LEADS results.
8. Have Claude propose targeted remediation.
9. Review, download, and execute the follow-up script locally.
10. Upload verification evidence and complete the flowchart.
11. Reopen the session with all documents, versions, notes, and progress intact.

At every step, private content must remain private unless the user explicitly publishes it.

## 14. Open Questions Before Implementation

1. **Score logic:** What is the intended branch when the final point count is not 100? The supplied diagram's `If >100` loop may need clarification.
2. **LEADS formats:** What specific output formats do the LEADS scripts generate, and which fields should Armadillo parse and display?
3. **Forensic questions:** Must they be finished before initial hardening, or tracked as a parallel required task?

These questions do not block further interface specification, but should be resolved before the corresponding features are implemented.

---

**Planning status:** Product architecture, core navigation, access model, content separation, and first-release boundaries are defined. No website or source code has been created.
