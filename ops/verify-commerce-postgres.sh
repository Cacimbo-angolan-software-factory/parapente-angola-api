#!/usr/bin/env bash
set -euo pipefail
image=${1:?image required}
release=${2:?release directory required}
suffix="$(date -u +%Y%m%d%H%M%S)-$$"
network="parapente-commerce-qa-$suffix"
qa_db="parapente-commerce-qa-db-$suffix"
qa_api="parapente-commerce-qa-api-$suffix"
label="commerce-$suffix"
password="$(openssl rand -hex 24)"
jwt="$(openssl rand -hex 32)"

cleanup() {
  for container in "$qa_api" "$qa_db"; do
    if [[ "$(docker inspect -f '{{index .Config.Labels "io.cacimbo.qa"}}' "$container" 2>/dev/null || true)" == "$label" ]]; then
      docker rm -fv "$container" >/dev/null
    fi
  done
  if [[ "$(docker network inspect -f '{{index .Labels "io.cacimbo.qa"}}' "$network" 2>/dev/null || true)" == "$label" ]]; then
    docker network rm "$network" >/dev/null
  fi
}
trap cleanup EXIT

docker network create --internal --label "io.cacimbo.qa=$label" "$network" >/dev/null
docker run -d --name "$qa_db" --network "$network" --label "io.cacimbo.qa=$label" \
  --memory=384m --tmpfs /var/lib/postgresql/data -e POSTGRES_DB=parapente_commerce_qa \
  -e POSTGRES_USER=parapente -e "POSTGRES_PASSWORD=$password" postgres:17-alpine >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$qa_db" pg_isready -U parapente -d parapente_commerce_qa >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$qa_db" psql -U parapente -d parapente_commerce_qa -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE web_anon NOLOGIN; CREATE ROLE web_service NOLOGIN;' >/dev/null
docker exec parapente-platform-db-1 pg_dump -U parapente -d parapente --schema-only --no-owner --no-privileges \
  | docker exec -i "$qa_db" psql -U parapente -d parapente_commerce_qa -v ON_ERROR_STOP=1 >/dev/null
docker run -d --name "$qa_api" --network "$network" --label "io.cacimbo.qa=$label" \
  --memory=256m -v "$release/ops/test-commerce-postgres.mjs:/app/test-commerce-postgres.mjs:ro" \
  -e "DATABASE_URL=postgres://parapente:$password@$qa_db:5432/parapente_commerce_qa" \
  -e "JWT_SECRET=$jwt" -e SMTP_ENDPOINT= -e WHATSAPP_ENDPOINT= "$image" >/dev/null
for attempt in $(seq 1 45); do
  if docker exec "$qa_api" node -e 'fetch("http://127.0.0.1:8080/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    docker exec "$qa_api" node test-commerce-postgres.mjs
    exit 0
  fi
  sleep 1
done
docker logs --tail 50 "$qa_api" >&2
exit 1
