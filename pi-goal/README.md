# pi-goal (beads)

Goal mode extension for pi using **beads** for persistence instead of markdown files.

## Overview

This is a rewrite of [capyup/pi-goal](https://github.com/capyup/pi-goal) that replaces the file-based storage (`.pi/goals/*.md`) with beads database persistence.

## Key Changes

- **Storage**: Goals stored via `sessionManager.appendCustomEntry()` instead of `.pi/goals/*.md` files
- **Focus**: Still tracked via session entries (no path-based tracking)
- **Ledger**: Events appended to session via custom entries
- **No more file I/O**: Removed `storage/goal-files.ts`, replaced with `storage/goal-beads.ts`

## Commands

All original commands preserved:
- `/goals <topic>` - Discuss a new goal
- `/sisyphus <topic>` - Discuss a Sisyphus goal
- `/goals-set <objective>` - Immediately create a goal
- `/sisyphus-set <objective>` - Immediately create a Sisyphus goal
- `/goal-status` - Show current goal
- `/goal-list` - List all open goals
- `/goal-focus` - Focus an open goal
- `/goal-tweak` - Refine the current goal
- `/goal-pause` - Pause the goal
- `/goal-resume` - Resume a paused goal
- `/goal-clear` - Clear the goal
- `/goal-abort` - Abort the goal

## Install

```bash
pi install git:github.com/nyanshak/pi-goal
```

Or from local checkout:
```bash
pi install .
```

Or try without installing:
```bash
pi -e ~/src/github.com/nyanshak/pi-extensions/pi-goal
```