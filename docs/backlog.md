# Backlog

Open follow-ups that are not blocking current release. Each entry has a
short ID, priority, and one-line description; full context lives in the
linked ADR / task-doc.

## Format

- `BLG-NNN` — short ID, stable, used in commits and PR titles
- `Priority` — `low` / `medium` / `high` (urgency, not effort)
- `Status` — `open` / `in-progress` / `done` / `wontfix`
- `Context` — pointer to ADR / task-doc / issue

---

## BLG-001 — Cleanup `[lts]` debug console output before 1.6.0

- **Priority**: low
- **Status**: open
- **Context**: ADR-0006, TASK-LTS-Local-Transcription-Menu.md
- **Description**: `background.js` (~27 statements) and `content.js` (~6 statements) currently log every step of the LTS flow with `console.log('[lts] …')`. Kept in 1.5.0 for first-deploy diagnostics. Before 1.6.0, trim to:
  - keep all `console.error` / `console.warn` (real failures)
  - drop `console.log` info-level statements
  - keep ONE summary log on terminal state (`[lts] job_id=X done in Ns, text length=M bytes`)
- **Acceptance**: `grep -c "console.log('\[lts\]" background.js content.js` returns ≤ 4 (down from ~33). No regressions in error visibility.

---

## Future ideas (not yet scheduled)

- Job history UI (last N jobs with transcript-path / ack-state / timestamps) — see ADR-0006 «Дальнейшее развитие»
- Per-video language override (`&lang=ru` query param) — see ADR-0006 «Дальнейшее развитие»
- CWS-publishing migration path (auth.json → chrome.storage.local + options page) — see ADR-0006 «Дальнейшее развитие»
- Pre-commit hook / CI gate to fail on accidental `auth.json` commit — see TASK-LTS §3 guardrails