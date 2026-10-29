# Running Rifter on your Mac (no Terminal typing)

Rifter runs on your own Mac and opens in your browser. Your collection stays on
this Mac. It only works while the Mac is on and Docker Desktop is running.

These launchers were written and syntax-checked in a cloud sandbox. They have
**not** been run on a real Mac yet; if one fails, copy the text in its window
and send it to Claude.

## One-time install (normal downloads, no commands)

1. **Docker Desktop**: download from https://www.docker.com/products/docker-desktop/
   (pick Apple Silicon or Intel to match your Mac: Apple menu > About This Mac).
   Open it once and accept the prompts.
2. **Git and Python**: macOS offers to install its "developer tools" the first
   time they are needed. Click **Install** when asked. You can also trigger it
   by running the setup launcher below.
3. **Get the files with GitHub Desktop** (desktop.github.com): sign in, choose
   **File > Clone repository**, pick `Fr3nchyz/rifter`, and clone it. Do not use
   **Download ZIP**: the ZIP has no git history, and setup needs it to fetch the
   `upstream/openrift` folder. (Or ask a Claude Code session on your Mac to clone
   it with `git clone --recurse-submodules`.)

## First run

1. Double-click **Set up Rifter.command**.
2. macOS may say it is from an unidentified developer. Right-click the file,
   choose **Open**, then **Open** again. You only do this once per file.
3. Wait 10 to 20 minutes. It downloads the card catalog and builds the app.
   Leave the window open until it says Rifter is running; your browser then opens.
4. **Create your account** on the sign-up page. The six-digit verification code
   arrives in a local mailbox at http://localhost:8025 (not real email).

## Every day

| Double-click | What it does |
|---|---|
| **Start Rifter.command** | Starts Docker if needed, starts Rifter, opens it in your browser. |
| **Stop Rifter.command** | Stops Rifter. Your data is kept. |
| **Backup Rifter.command** | Saves a backup file and opens its folder. Copy it to iCloud Drive or an external drive now and then. |

## Updating

When a new version is available: in GitHub Desktop click **Fetch origin** then
**Pull origin**, then double-click **Start Rifter.command**. It notices the new
version, installs it (a few minutes, the first time after each update), and opens
the app. Your data is kept.

## Using it from your PC or phone later

Not set up yet. By default the app only answers on the Mac itself
(`http://localhost:5173`). Reaching it from other devices needs a network
address set at setup time (see `docs/RIFTER_APP.md`, `--origin`) and, for use
away from home, Tailscale. Ask Claude when you want this.

## If something goes wrong

- Docker "not running": open Docker Desktop and wait for it to say it is running.
- A window shows an error: copy the last 20 lines and send them to Claude.
- Logs: `.local/run/supervisor.log` inside the Rifter folder.
