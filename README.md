# İlçeler Kıyameti

A shared, live map of Turkey's 973 districts (ilçeler) and Cyprus' 11, coloured by province (il). Northern Cyprus appears as **KKTC** and the south as **GKRY**. Anyone can pick a district and:

- **sink it into the sea** (it disappears and becomes water),
- **merge it into another district**, anywhere on the map (neighbours not required),
- **rename it**,
- **move it to another province**, or found a brand-new province for it,
- **move it to another country**: any real country (de facto ones included) or a brand-new one.

Provinces can also be **renamed**, **recoloured** (preset colours or an RGB panel), **moved to another country** or **sunk entirely**. Provinces outside Turkey show their country under their name, and borders between countries are drawn in red. Anything under the sea can be **raised again**: tap the water where a district used to be and press **Denizden çıkar** (or raise its whole province). Every change reaches everyone instantly, and the **Son değişiklikler** panel shows a live feed of who did what. After each change you wait **10 seconds**. The database enforces this wait, so reloading the page does not skip it.

The site is static (GitHub Pages). Live sync uses a free Firebase Realtime Database.

## Setup (about 10 minutes)

### 1. Create the Firebase backend

1. Go to <https://console.firebase.google.com> → **Add project**. Analytics is not needed. The free **Spark** plan is enough.
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable → Save.**
   Visitors are signed in anonymously in the background. The cooldown is tied to that anonymous user.
3. **Build → Realtime Database → Create database.** Pick a location and start in **locked mode**.
4. Open the database's **Rules** tab, paste the contents of [`database.rules.json`](database.rules.json) and press **Publish**.
   (With the Firebase CLI you can run `firebase deploy --only database` instead.)
5. **Project settings (⚙) → General → Your apps → Web (`</>`)**: register an app (Hosting not needed) and copy the values into [`js/config.js`](js/config.js):

   ```js
   export const FIREBASE_CONFIG = {
     apiKey: 'AIza…',
     authDomain: 'your-project.firebaseapp.com',
     databaseURL: 'https://your-project-default-rtdb.europe-west1.firebasedatabase.app',
     projectId: 'your-project',
     appId: '1:…:web:…',
   };
   ```

   These values are public by design. The database rules are what protect the data.

You don't need to import anything. The first visitor's browser fills the empty database with the original map.

### 2. Publish on GitHub Pages

Commit `js/config.js` to the branch you publish. Then go to **Settings → Pages → Build and deployment → Deploy from a branch**, pick that branch and `/ (root)`. The site appears at `https://<user>.github.io/<repo>/`.

### Optional hardening

- In Google Cloud Console → APIs & Services → Credentials, restrict the browser API key to the HTTP referrer `https://<user>.github.io/*`.
- Enable Firebase **App Check** (reCAPTCHA) to make scripted clients harder.

### Updating the rules later

When `database.rules.json` changes, paste the new version into **Realtime Database → Rules** and press **Publish**. The rules stay compatible with older copies of the site that people still have open, and the site only shows features the published rules support. So publishing before or after the site update is equally safe.

- Raising districts from the sea needs the rules that expose `caps`.
- Countries, province colours and the Cyprus districts need the rules that expose `caps3`. Until those are published, the Cyprus districts are shown but locked. Once they are, the first visitor adds the Cyprus districts to the live database. Open pages notice the new rules the next time someone selects a district.

### Resetting the map

In the Realtime Database **Data** tab, delete the `state`, `log` and `cool` nodes. The next visitor re-seeds the original map.

## How it works

| Piece | What it does |
| --- | --- |
| `data/map.json` | 973 districts as a shared-border topology (OpenStreetMap boundaries via geoBoundaries), projected to Mercator, simplified and quantized to a 30 m grid. Includes lakes and neighbouring countries. About 330 KB gzipped. |
| `js/view.js` | Canvas renderer. Merged districts are drawn without inner borders, and border lines are redrawn by type (district, province, coast, country) whenever the state changes. |
| `js/state.js` | The game state: merge chains, sunk districts and provinces, colours, labels and stats. |
| `js/backend.js` | Firebase Realtime Database sync. Without a config it falls back to a local demo mode. It also adds districts newer than the live database (`buildTopUp`) without touching existing ones. |
| `js/countries.js` | Turkish names of 203 countries, including de facto ones (KKTC, Kosova, Tayvan, Abhazya, …), generated from Natural Earth. |
| `database.rules.json` | Server-side validation and the 10-second cooldown. |
| `vendor/firebase.js` | The Firebase SDK, tree-shaken and bundled (≈70 KB gzipped, no CDN). |

**Performance.** Geometry is simplified per zoom level (Douglas–Peucker on the shared arcs, so borders never crack) and batched into one path per colour per tile. Only visible tiles are drawn. The expensive layer is rendered into an offscreen bitmap; panning, pinching and flying just transform that bitmap, and a sharp redraw follows when the motion stops. Hit-testing uses bounding boxes plus `isPointInPath`. Clients download the ~35 KB state once, then receive only the changed nodes.

**Cooldown and integrity.** One change is one atomic multi-path write: the changed fields of exactly one district or province, the user's `cool/<uid>` timestamp, and a log entry. The rules require all three to carry the server's own timestamp (`now`). The previous `cool/<uid>` must be at least 10 000 ms older. Each write can touch only the single target named in the cooldown entry. The rules also refuse merges into dead or merged targets (so merge cycles can't form) and moves into sunk provinces. A sunk or merged district can only be written to raise it: the write must clear its sea flag and merge link and put it in a living province. Everything that had merged into it comes back with it. A sunk province can only be written to raise it. Countries and custom colours are optional province fields (`k`, `rgb`). Every province still keeps a palette index (`c`), so older pages show the nearest palette colour. A player-founded country (`state/c`) can only be created together with the province that uses it. Districts and provinces newer than the original seed (the Cyprus ones) can be created once each by any visitor, but only as plain, unsunk nodes.

**Never renumber districts.** The live game stores its state under the district index. `tools/build-map.mjs` refuses to build if any of the first 973 districts or 81 provinces would change, so new districts can only be appended. Concurrent edits to different fields of the same district don't overwrite each other.

The cooldown follows the anonymous Firebase user, so reloads and new tabs don't skip it. A visitor who clears site data or opens a private window becomes a new anonymous user. Per-IP limits would need a server (Cloud Functions on the paid plan).

**Free-tier limits.** The Spark plan allows **100 simultaneous connections**, 1 GB stored and 10 GB downloaded per month. Each visit costs roughly 35 KB plus a few hundred bytes per change. If the site gets popular, switch the project to the pay-as-you-go **Blaze** plan to lift the connection cap.

## Development

```bash
python3 -m http.server 8080          # then open http://localhost:8080
```

- With an empty `js/config.js`, the site runs in **demo mode**. Changes stay in your browser and sync between its tabs.
- `?demo` forces demo mode even when Firebase is configured, so you can try things without touching the live game.
- `?emulator=127.0.0.1:9000` connects to a local Realtime Database emulator (`npx firebase-tools emulators:start --only database --project demo-ilceler`).

Tools (`cd tools && npm install`):

```bash
node build-map.mjs        # rebuild data/map.json from geoBoundaries + Natural Earth
node build-countries.mjs  # rebuild js/countries.js (run build-map.mjs first; it caches the data)
node build-firebase.mjs   # rebuild vendor/firebase.js
# test the security rules (run from the repository root):
npx firebase-tools emulators:exec --only database --project demo-ilceler "node tools/test-rules.mjs"
```

`firebase-tools` isn't a dependency. `npx` fetches it. The rules test covers 81 cases: the cooldown, one target per write, server timestamps, merge, sink, raise and province rules, countries, colours, the Cyprus top-up, concurrent edits and unauthenticated access.

## Data and licences

- District boundaries: © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/), via [geoBoundaries](https://www.geoboundaries.org/) (gbOpen TUR ADM2/ADM1).
- Cyprus: village boundaries from geoBoundaries gbOpen CYP ADM2 (Wikipedia / Cyprus Department of Lands and Surveys, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)). The KKTC/GKRY line is from Natural Earth. No open dataset has the KKTC's six districts, so they are assembled from village boundaries: Lefke and Güzelyurt villages are listed by name, and the rest follow their old district. Borders between KKTC districts are therefore approximate. The UN buffer zone and the British bases are counted with the southern districts next to them.
- Lakes, neighbouring countries and country names: [Natural Earth](https://www.naturalearthdata.com/) (public domain).
