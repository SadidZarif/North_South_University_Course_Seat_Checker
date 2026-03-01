# NSU Course Seat Checker (Chrome Extension)

Chrome/Edge extension that **automatically checks NSU RDS course seat availability** on `rds3.northsouth.edu` / `rds4.northsouth.ac.bd`.

> **Important:** This public repo intentionally does **not** ship the real seat-checking implementation (`content.js`).  
> The extension will load, but actual seat checking requires the private `content.js`.

---

## What this extension does

- **Auto refresh + auto scan**: Refreshes the page on an interval and scans for matching course/section pairs.
- **Multi mode (up to 7 pairs)**: Continuously checks up to 7 course-section pairs.
- **Beast mode (single pair)**: Stops immediately when a seat is found, focuses the tab, highlights the relevant row, and triggers **sound/TTS alerts**.
- **Notifications + event log**: Shows Chrome notifications and writes events to the popup “Terminal” log.

---

## How it works (architecture)

This extension has 3 main parts:

- **Popup UI** (`popup.html` + `popup.js`)
  - You set mode, course, section, and refresh interval.
  - It sends `START`/`STOP` messages to the content script in the active tab.
  - It reads status/state from `chrome.storage.local` to render UI updates.

- **Content script** (Private) (`content.js`)
  - Finds the course+section row from the RDS page DOM / DataTables.
  - Parses seat info (e.g. `taken(total)` or a plain available-seat number).
  - Sends `SEAT_FOUND` to the background service worker when availability is detected.
  - In Beast mode, reveals/filters + highlights the row and hard-stops further checks.
  - Persists state and resumes after refresh via `window.location.reload()`.

- **Background service worker** (`background.js`)
  - When it receives `SEAT_FOUND`:
    - Updates the event log (last 100 lines)
    - Updates stored state (lastFound/details)
    - Shows a notification
    - In Beast mode, plays a reliable beep via an offscreen document (fallback: TTS)
    - In Beast mode, focuses the tab and sends `FOCUS_COURSE` to the content script (reveal/highlight)

For reliable audio in MV3 (autoplay policies), it uses an **Offscreen Document**:
- `offscreen.html` + `offscreen.js`

---

## Modes

### Multi (up to 7 pairs)
- Multiple course-section pairs are checked continuously.
- When a seat is found, it notifies/logs, but **keeps running** to continue checking other pairs.

### Beast (single pair)
- Supports only 1 course-section pair.
- As soon as a seat is found:
  - Checking stops
  - Notification + beep/TTS
  - Relevant row is highlighted
  - Tab is focused

---

## Data source / privacy

- This extension **does not send data to any external server**.
- It only reads data from the RDS page you have open (DOM/DataTables).
- Settings are stored in `chrome.storage.sync` (and may sync with your browser profile).

---

## Stored keys (for debugging)

- **Sync storage** (`chrome.storage.sync`)
  - `mode`, `course`, `section`, `refreshInterval`
- **Local storage** (`chrome.storage.local`)
  - `nsuSeatCheckerState`: running/found state, lastFound, details, queue info, etc.
  - `nsuSeatCheckerLog`: event lines (CHECK/FOUND/START/STOP)

---

## Permissions (why they’re needed)

From `manifest.json`:
- **activeTab / scripting**: Inject/message the content script in the active tab
- **notifications**: Show a notification when a seat is available
- **storage**: Persist settings, state, and logs
- **offscreen**: Reliable MV3 audio playback
- **tts**: Fallback voice alert if audio fails
- **host_permissions**: Restrict operation to `rds3` / `rds4`

---

## Setup (install)

### 1) Clone
```bash
git clone https://github.com/SadidZarif/North_South_University_Course_Seat_Checker.git
cd North_South_University_Course_Seat_Checker
```

### 2) Get the private `content.js` (required for real seat checking)

This repository intentionally does not publish the real checker implementation.

- **To get `content.js`, contact the author:**
  - **Name:** Sadid Zarif Prinon
  - **Email:** `smszprinon@myseneca.ca`

The private `content.js` contains the core logic, including:
- RDS3 table scanning + `taken(total)` seat parsing
- RDS4 DataTables API-based scanning (internal scanning without visible typing/search)
- Seat match logic (course/section) + availability detection
- Auto refresh + resume-after-refresh state management
- Beast mode reveal/filter + row highlight behavior
- Robust message handlers: `PING`, `START`, `STOP`, `STATUS`, `FOCUS_COURSE`
- Log batching + serialized state writes (to avoid race conditions)

**How to enable after you receive it**
- Option A (recommended): Replace the contents of `content.example.js` with the private `content.js` (keep the filename the same)
- Option B: Change `manifest.json` and `popup.js` to reference `content.js` instead

> Note: `content.js` is included in `.gitignore` to prevent accidental public pushes.

### 3) Load as unpacked extension
- Chrome/Edge → `chrome://extensions`
- **Developer mode ON**
- **Load unpacked** → select this project folder

### 4) Use
- Open the course list page on `rds3` / `rds4`
- Click the extension icon to open the popup
- Set mode + course/section and press Start

---

## License

This project is licensed under the **MIT License**. See `LICENSE`.

---

## Copyright

Copyright (c) 2026 Sadid Zarif Prinon

---

## Disclaimer

This is **not** an official NSU product and is not affiliated with North South University.  
If the RDS UI/structure changes, selectors/parsing may need updates.
