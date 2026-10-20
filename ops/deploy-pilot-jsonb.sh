#!/usr/bin/env bash
set -euo pipefail

project=/opt/parapente-platform
release="$project/api-releases/pilot-jsonb-1.6.8-20261020"
compose="$project/docker-compose.yml"
backup="$release/rollback"
expected_compose=a74fae65889f23e0b97cfc5f66ca24941a819d4460e9ac4536d72ecbf0863a6f
expected_old_image=sha256:530b3b3e2dce7339785888609d995169b4dab85d3dd824244132f47c9aa29e21
expected_new_image=sha256:9278747d8c7697013eb1c8a1ed31feddb5e5638fbec1d3ec40739d3819bc4272

test "$(sha256sum "$compose" | cut -d' ' -f1)" = "$expected_compose"
test "$(docker inspect -f '{{.Image}}' parapente-platform-api-1)" = "$expected_old_image"
test "$(docker image inspect -f '{{.Id}}' parapente-angola-api:1.6.8-jsonb)" = "$expected_new_image"
test ! -e "$backup"
db_container=$(docker inspect -f '{{.Id}}' parapente-platform-db-1)
rest_container=$(docker inspect -f '{{.Id}}' parapente-platform-postgrest-1)
install -d -m 700 "$backup"
cp -p "$compose" "$backup/docker-compose.yml"
if [ -f "$project/.env" ]; then cp -p "$project/.env" "$backup/.env"; fi
docker compose --project-directory "$project" -p parapente-platform -f "$release/compose.next.yml" config --quiet

rollback() {
  cp -p "$backup/docker-compose.yml" "$compose"
  docker tag "$expected_old_image" ghcr.io/cacimbo-angolan-software-factory/parapente-angola-api:latest
  docker compose --project-directory "$project" -p parapente-platform -f "$compose" up -d --no-deps --pull never api
}
cp "$release/compose.next.yml" "$compose"
if ! docker compose --project-directory "$project" -p parapente-platform -f "$compose" up -d --no-deps --pull never api; then
  rollback
  exit 1
fi
healthy=false
for attempt in $(seq 1 20); do
  if docker exec parapente-platform-api-1 node -e 'fetch("http://127.0.0.1:8080/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done
if [ "$healthy" != true ]; then rollback; exit 1; fi
test "$(docker inspect -f '{{.Image}}' parapente-platform-api-1)" = "$expected_new_image"
test "$(docker inspect -f '{{.Id}}' parapente-platform-db-1)" = "$db_container"
test "$(docker inspect -f '{{.Id}}' parapente-platform-postgrest-1)" = "$rest_container"
docker exec parapente-platform-api-1 node -p '"API package version: " + require("./package.json").version'
echo 'Only API replaced; database and PostgREST containers unchanged.'
