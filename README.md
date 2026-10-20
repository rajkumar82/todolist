# Todo

Todo lists per person, with an efficiency rating. Sign in with Google and you get your own space, created
on first sign-in and stored under your Google account (its permanent `sub` id, so a name or email change
doesn't lose it). Each user has lists (Personal, Office, Family, Friends to
start; add, rename and delete freely), and each list has items with a checkbox and an optional due date
and time. Built mobile-first and installable to the home screen. Node/Express backend, plain HTML/JS front end.

Sign-in uses Google Identity Services: the browser gets an ID token, `POST /api/auth/google` verifies it
(`google-auth-library`) and sets a signed, HttpOnly 30-day `session` cookie. The app's data API is
`/api/me/...`, which always resolves to the signed-in account. Pages are marked `noindex`.

## Google setup

1. Google Cloud Console > APIs & Services > Credentials > Create OAuth client ID > Web application.
2. Authorized JavaScript origins: the Cloud Run URL (and `http://localhost:8080` for local runs).
   No redirect URI is needed.
3. Set `GOOGLE_CLIENT_ID` and a random `SESSION_SECRET` on the service.
4. Optional `LEGACY_CLAIMS=rajkumar=you@gmail.com`: the first time that verified email signs in, the old
   name-keyed space (`users/rajkumar.json`) is copied to the account. Old `/<name>` links now redirect to `/`.

## Run locally

    npm install
    DEV_USER=me npm start   # http://localhost:8080, signed in as "me" without Google; data in ./data
    npm test           # unit tests for the rating logic

## Deploy to GCP (Cloud Run + Cloud Storage)

    gcloud storage buckets create gs://YOUR-BUCKET --location=REGION
    gcloud run deploy todolist --source . --region REGION --allow-unauthenticated \
      --set-env-vars BUCKET=YOUR-BUCKET,GOOGLE_CLIENT_ID=...,SESSION_SECRET=...

The Cloud Run service account needs `roles/storage.objectAdmin` on the bucket.
Do not add a lifecycle rule to the bucket: user data is meant to be kept indefinitely.

## Storage

Per user, two JSON files (in the bucket, or `./data/users` locally):

- `users/g-<sub>.json`: lists and items (the current state).
- `users/g-<sub>.history.json`: append-only log of every change (created, edited, checked, deleted...).
  It is only kept in storage, the app does not show it.

Writes use the bucket's generation check, so two devices saving at once never overwrite each other
(the loser retries on the fresh copy).

## Efficiency rating

Shown on the Insights tab as a tier (Unstoppable / On fire / Steady / Warming up / Time to catch up),
not a number. It is computed in `score.js` from item timestamps over the last 30 days:
completion (40%), timeliness against the due time, or 3 days when there is none (40%), and days with
something finished in the last 7 (20%). Items not yet due never count against you.

## Notes

- Limits: 50 lists per user, 500 items per list.
- The service worker keeps the app and your last-loaded lists available offline (read-only); signing out clears it.
- `npm run icons` regenerates the icons in `public/` (`tools/make-icons.js`).
