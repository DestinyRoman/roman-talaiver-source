# Roman's Planner

Homework, quizzes, tests and projects on a board and a calendar. Lives at `roman.talaiver.com/planner/`.

## How it works

| Piece | What it does |
|---|---|
| `index.html`, `app.js`, `planner.css` | The app. Plain HTML/JS + Tailwind CDN, no build step. |
| `data/planner.json` | All tasks and classes. The app commits here through the GitHub API (autosave about 15s after the last edit). |
| `data/canvas.json` | Canvas assignments, written by the `planner-sync` Action. New ones show up in To Do automatically. |
| `calendar.ics` | Subscribable calendar feed, rebuilt by the Action whenever `planner.json` changes. |
| `scripts/sync.mjs` | The script the Action runs. |

Statuses are To Do, In Progress, In Review, Complete, Turned In. None are required; drag a card to any column.

If Canvas moves a due date and Roman never changed it by hand, the planner follows Canvas. If he dragged it himself, his date wins.

## One-time setup

### 0. Move the workflow into place
Move `planner/setup/planner-sync.yml` to `.github/workflows/planner-sync.yml` before pushing (or create it in the GitHub web UI under Actions > New workflow).

### 1. Token so the app can save (on each device Roman uses)
1. Signed in as **DestinyRoman**, go to GitHub > Settings > Developer settings > Fine-grained tokens > Generate new token.
2. Repository access: **Only select repositories** > `roman-talaiver-source`.
3. Permissions: **Contents: Read and write**. Optional: **Actions: Read and write** (enables the "Sync Canvas now" button).
4. Open the planner > ⚙ Settings > paste the token > Connect & load.

The token is stored only in that browser. Set an expiration you will remember (90 days is reasonable).

### 2. Canvas feed
1. In Canvas, open **Calendar** and click **Calendar Feed** (bottom right). Copy the URL.
2. In the GitHub repo: Settings > Secrets and variables > Actions > New repository secret.
   Name `CANVAS_ICS_URL`, value = that URL.
3. Actions tab > planner-sync > Run workflow (or wait for the next scheduled run).

### 3. Calendar subscription
Subscribe to `https://roman.talaiver.com/planner/calendar.ics`
(Google Calendar: Other calendars > + > From URL. Apple: File > New Calendar Subscription.)
Google refreshes subscribed calendars on its own schedule, often every 8 to 24 hours.

## Heads up
- `planner.json` and `canvas.json` are publicly readable on the site and in the repo, same as everything else here.
- Every autosave is a commit, so `git log planner/data/planner.json` is the full history and any version can be restored.
