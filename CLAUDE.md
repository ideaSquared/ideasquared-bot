# CLAUDE.md

Cloudflare Worker that posts GitHub and deploy events to Discord (see README).

## Logging

- Server code logs through @ideasquared/log via `src/log.ts`, never `console.*`.
- No personal data or secrets in logs: no webhook URLs, signatures, tokens, GitHub usernames or request bodies.
- Free-text detail goes to the Discord #bot-logs post; the console gets a fixed event code.
- CI fails on console calls (a justified exception carries `// logging-exempt: <reason>` on the same line).
- Load the `logging` skill (`.claude/skills/logging`) before adding or changing a log line.

## Working rules

- Indent with tabs (`.editorconfig`, `.prettierrc`); YAML uses spaces.
- Type-check: `pnpm exec tsc --noEmit` (`pnpm typecheck` also checks `test/`). Lint and format: `pnpm lint`, `pnpm format:check`.
- Tests: `pnpm test --run` (Vitest in the Workers pool).
