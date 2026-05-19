# SDOH Place Intake API

Small Netlify-hosted submission intake API for the SDOH Place contributor workflow.

It implements the API used by both:

- `sdohplace-data-discovery`
- `SDOHPlace-MetadataManager`

## Endpoints

```text
GET    /submissions
POST   /submissions
GET    /submissions/:id
PATCH  /submissions/:id
DELETE /submissions/:id
POST   /submissions/:id/decision
```

All non-`OPTIONS` requests require:

```text
Authorization: Bearer <INTAKE_API_TOKEN>
```

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

Netlify Dev serves the API at:

```text
http://localhost:9090/submissions
```

Point both existing apps at it:

```env
INTAKE_API_BASE_URL=http://localhost:9090
INTAKE_API_TOKEN=change-me
```

Use the same token value in this project and in the caller apps.

## Deploy to Netlify

Set these environment variables in Netlify:

```env
INTAKE_API_TOKEN=<strong-random-token>
INTAKE_API_CORS_ORIGINS=https://your-discovery-site,https://your-metadata-manager-site
INTAKE_STORE_NAME=submissions
```

Do not set `INTAKE_STORAGE_DRIVER=file` in Netlify production. That local-only setting is used by Netlify Dev before the site has Netlify Blobs context.

Then deploy this repository to Netlify. Configure the other apps with:

```env
INTAKE_API_BASE_URL=https://your-intake-api.netlify.app
INTAKE_API_TOKEN=<same-token>
```

## Storage note

This project uses Netlify Blobs as a simple JSON data store. It is a good lightweight staging or low-volume solution. If submission volume or audit requirements grow, keep this HTTP contract and migrate the storage layer to DynamoDB/Postgres later.
