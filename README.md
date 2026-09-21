# Todo

Todo lists per person, with an efficiency rating. Open `/<name>` (e.g. `/rajkumar`) and you get that
person's space; it is created on first visit. Each user has lists (Personal, Office, Family, Friends to
start; add, rename and delete freely), and each list has items with a checkbox and an optional due date
and time. Built mobile-first and installable to the home screen. Node/Express backend, plain HTML/JS front end.

There is no login: the name in the URL is the only key, so anyone who knows a name can open that space.
Pages are marked `noindex` so search engines skip them.

## Run locally

    npm install
    npm start          # http://localhost:8080/yourname, data stored in ./data
    npm test           # unit tests for the rating logic

## Deploy to GCP (Cloud Run + Cloud Storage)

    gcloud storage buckets create gs://YOUR-BUCKET --location=REGION
    gcloud run deploy todolist --source . --region REGION --allow-unauthenticated \
      --set-env-vars BUCKET=YOUR-BUCKET

The Cloud Run service account needs `roles/storage.objectAdmin` on the bucket.
Do not add a lifecycle rule to the bucket: user data is meant to be kept indefinitely.

## Storage

Per user, two JSON files (in the bucket, or `./data/users` locally):

- `users/<name>.json`: lists and items (the current state).
- `users/<name>.history.json`: append-only log of every change (created, edited, checked, deleted...).
  It is only kept in storage, the app does not show it.

Writes use the bucket's generation check, so two devices saving at once never overwrite each other
(the loser retries on the fresh copy).

## Efficiency rating

Shown on the Insights tab as a tier (Unstoppable / On fire / Steady / Warming up / Time to catch up),
not a number. It is computed in `score.js` from item timestamps over the last 30 days:
completion (40%), timeliness against the due time, or 3 days when there is none (40%), and days with
something finished in the last 7 (20%). Items not yet due never count against you.

## Notes

- User names are lowercase letters, digits, `-` and `_`, up to 32 characters.
- Limits: 50 lists per user, 500 items per list.
- Installing: the manifest is served per user, so the home-screen icon opens that user's space.
  The service worker keeps the app and your last-loaded lists available offline (read-only).
- `npm run icons` regenerates the icons in `public/` (`tools/make-icons.js`).
