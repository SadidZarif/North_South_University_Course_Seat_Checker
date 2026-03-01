# NSU Course Seat Checker (Chrome Extension)

NSU RDS ( `rds3.northsouth.edu` / `rds4.northsouth.ac.bd` )-এ course seat **auto-check** করার জন্য একটা Chrome/Edge extension।

> **Important:** এই public repo-তে আসল seat-checking logic থাকা `content.js` intentionally রাখা হয়নি (private)।  
> Extension load হবে, কিন্তু seat checking চালু করতে হলে private `content.js` দরকার।

---

## What this extension does

- **Auto refresh + auto scan**: নির্দিষ্ট interval এ পেজ refresh করে এবং course/section match করে seat available কিনা চেক করে।
- **Multi mode (up to 7 pairs)**: একসাথে সর্বোচ্চ ৭টা course-section pair continuously চেক করে।
- **Beast mode (single pair)**: seat পেলেই checking থামিয়ে দেয়, tab focus করে, relevant row highlight করে এবং **sound/tts alert** দেয়।
- **Notifications + event log**: seat পাওয়া গেলে Chrome notification দেখায় এবং popup-এর “Terminal” log-এ event রেখে দেয়।

---

## How it works (architecture)

এটা মূলত ৩টা অংশে কাজ করে:

- **Popup UI** (`popup.html` + `popup.js`)
  - আপনি mode, course, section, refresh interval সেট করেন।
  - তারপর active tab-এ content script-কে `START`/`STOP` message পাঠায়।
  - UI status দেখাতে `chrome.storage.local` থেকে state পড়ে।

- **Content script** (Private) (`content.js`)
  - RDS পেজের DOM/DataTables থেকে course+section row খুঁজে বের করে।
  - seat info parse করে (যেমন `taken(total)` বা শুধু available number)।
  - seat available হলে background-এ `SEAT_FOUND` message পাঠায়।
  - Beast mode-এ row highlight + search/filter reveal করে এবং checking hard-stop করে।
  - Refresh interval অনুযায়ী `window.location.reload()` করে state persist করে resume করে।

- **Background service worker** (`background.js`)
  - `SEAT_FOUND` message পেলে
    - event log (last 100 lines) update করে
    - state update করে (lastFound/details)
    - notification দেখায়
    - Beast mode হলে offscreen document দিয়ে reliable beep play করে (fallback: TTS)
    - Beast mode হলে tab focus করে এবং content script-কে `FOCUS_COURSE` পাঠায় (row highlight/reveal করার জন্য)

Audio অংশটা MV3 autoplay policy এ reliable করার জন্য **Offscreen Document** ব্যবহার করা হয়েছে:
- `offscreen.html` + `offscreen.js`

---

## Modes

### Multi (up to 7 pairs)
- একাধিক course-section pair একসাথে চেক হয়।
- seat পাওয়া গেলে notification/log হয়, কিন্তু checking **চলতেই থাকে** (অন্যান্য pair চেক করার জন্য)।

### Beast (single pair)
- শুধুমাত্র ১টা course-section support করে।
- seat পাওয়া মাত্র:
  - checking বন্ধ হয়ে যায়
  - notification + beep/TTS
  - relevant row highlight হয়
  - tab focus হয়

---

## Data source / privacy

- এই extension **কোনো external server এ data পাঠায় না**।
- এটা শুধু আপনার open করা RDS page-এর DOM/DataTables থেকে তথ্য পড়ে।
- Settings `chrome.storage.sync`-এ save হয় (আপনার browser profile sync হলে সেটাও sync হতে পারে)।

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
- **activeTab / scripting**: active tab-এ content script inject/message করার জন্য
- **notifications**: seat available হলে notification দেখানোর জন্য
- **storage**: settings + state + logs persist করার জন্য
- **offscreen**: MV3-এ reliable audio playback
- **tts**: audio fail করলে fallback voice alert
- **host_permissions**: শুধু `rds3` / `rds4` ডোমেইনে কাজ করার জন্য

---

## Setup (install)

### 1) Clone
```bash
git clone https://github.com/SadidZarif/North_South_University_Course_Seat_Checker.git
cd North_South_University_Course_Seat_Checker
```

### 2) Get the private `content.js` (required for real seat checking)

এই repo-তে checker logic intentionally public করা হয়নি।

- **`content.js` পেতে হলে আমাকে contact করুন:**
  - **Name:** Sadid Zarif Prinon  
  - **Email:** `smszprinon@myseneca.ca`

Private `content.js`-এ মূলত এগুলো থাকে (core features):
- RDS3 table scanning + `taken(total)` seat parsing
- RDS4 DataTables API-based scanning (visible search না করেই internal scan)
- Seat match logic (course/section) + availability detection
- Auto refresh + resume-after-refresh state management
- Beast mode reveal/filter + row highlight behavior
- Robust message handlers: `PING`, `START`, `STOP`, `STATUS`, `FOCUS_COURSE`
- Log batching + state write serialization (race-condition avoid করার জন্য)

**How to enable after you receive it**
- Option A (recommended): Private `content.js` ফাইলের contents দিয়ে `content.example.js` **replace** করুন (ফাইল নাম একই রাখুন)  
- Option B: `manifest.json` এবং `popup.js`-এ script নাম `content.js` করে দিন

> Note: এই repo-তে `content.js` `.gitignore` করা আছে যাতে ভুল করে public push না হয়ে যায়।

### 3) Load as unpacked extension
- Chrome/Edge → `chrome://extensions`
- **Developer mode ON**
- **Load unpacked** → এই project folder select করুন

### 4) Use
- `rds3` / `rds4`-এ course list page open করুন
- extension icon → popup open করুন
- mode + course/section set করে Start দিন

---

## License

This project is licensed under the **MIT License**. See `LICENSE`.

---

## Copyright

Copyright (c) 2026 Sadid Zarif Prinon

---

## Disclaimer

This is **not** an official NSU product and is not affiliated with North South University.  
RDS UI/structure change হলে selector/parsing আপডেট লাগতে পারে।
