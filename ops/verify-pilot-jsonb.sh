#!/usr/bin/env bash
set -euo pipefail

candidate_image="${1:?candidate image required}"
context_dir="${2:?source directory required}"
qa_suffix="$(date -u +%Y%m%d%H%M%S)-$$"
qa_network="parapente-pilot-qa-${qa_suffix}"
qa_db="parapente-pilot-qa-db-${qa_suffix}"
qa_api="parapente-pilot-qa-api-${qa_suffix}"
qa_label="pilot-jsonb-${qa_suffix}"
qa_password="$(openssl rand -hex 24)"
qa_jwt="$(openssl rand -hex 32)"

cleanup() {
  for container in "$qa_api" "$qa_db"; do
    if [[ "$(docker inspect -f '{{index .Config.Labels "io.cacimbo.qa"}}' "$container" 2>/dev/null || true)" == "$qa_label" ]]; then
      docker rm -fv "$container" >/dev/null
    fi
  done
  if [[ "$(docker network inspect -f '{{index .Labels "io.cacimbo.qa"}}' "$qa_network" 2>/dev/null || true)" == "$qa_label" ]]; then
    docker network rm "$qa_network" >/dev/null
  fi
}
trap cleanup EXIT

docker network create --internal --label "io.cacimbo.qa=$qa_label" "$qa_network" >/dev/null
docker run -d --name "$qa_db" --network "$qa_network" --label "io.cacimbo.qa=$qa_label" \
  --memory=384m --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_DB=parapente_pilot_qa -e POSTGRES_USER=parapente -e "POSTGRES_PASSWORD=$qa_password" \
  postgres:17-alpine >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$qa_db" pg_isready -U parapente -d parapente_pilot_qa >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$qa_db" psql -U parapente -d parapente_pilot_qa -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE web_anon NOLOGIN; CREATE ROLE web_service NOLOGIN;' >/dev/null
# Copy structure only. No production users, passwords, JWT secrets or rows.
docker exec parapente-platform-db-1 pg_dump -U parapente -d parapente --schema-only --no-owner --no-privileges \
  | docker exec -i "$qa_db" psql -U parapente -d parapente_pilot_qa -v ON_ERROR_STOP=1 >/dev/null

docker run -d --name "$qa_api" --network "$qa_network" --label "io.cacimbo.qa=$qa_label" \
  --memory=256m -v "$context_dir/test:/app/test:ro" \
  -e "DATABASE_URL=postgres://parapente:$qa_password@$qa_db:5432/parapente_pilot_qa" \
  -e "JWT_SECRET=$qa_jwt" -e PILOT_QA_ENABLED=1 -e SMTP_ENDPOINT= -e WHATSAPP_ENDPOINT= \
  "$candidate_image" >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$qa_api" node -e 'fetch("http://127.0.0.1:8080/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$qa_api" node --test test/managed-user.integration.test.mjs
