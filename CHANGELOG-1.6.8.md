# API 1.6.8 - Pilot creation JSONB fix

The live `/admin/users` handler failed with PostgreSQL `22P02` when creating a
pilot. node-postgres treated `level_history` (an array) as a PostgreSQL array
literal, while `profiles.level_history` is JSONB. The API now JSON-encodes this
field before binding SQL parameters. NULL and other scalar fields are unchanged.
No database migrations, account data changes or notification changes are included.

Validation:

- 12 unit/regression tests passed. The opt-in integration test is skipped unless
  `PILOT_QA_ENABLED=1` and checks the isolated database name/host before writing.
- Isolated PostgreSQL 17 database with the production schema only, no copied rows,
  production credentials or host ports. Test network is internal.
- 10 integration assertions passed against the real API handler: pilot creation
  HTTP 201 with JSONB round trip, empty history, NULL, client creation, agent
  scope, duplicate email 409, unauthorized/inactive/non-admin rejection,
  health and authenticated user lookup.
- QA containers and network are removed by a label-checked cleanup trap.

Deployment uses `ops/pilot-jsonb.Dockerfile` on top of the exact saved production
image, without upgrading dependencies or replacing migration files. A saved
rollback image and Compose/config backup must be retained. Update only service
`api` with `--no-deps --pull never`; never use `compose down -v`.

Frontend remains 1.7.0; API package version is independently incremented to 1.6.8.
