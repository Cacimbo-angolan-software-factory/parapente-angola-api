#!/usr/bin/env bash
set -euo pipefail
project=/opt/parapente-platform
release="$project/api-releases/commerce-1.7.0-20261117"
compose="$project/docker-compose.yml"
backup="$release/rollback"
old_tag=parapente-angola-api:1.6.8-jsonb
new_tag=parapente-angola-api:1.7.0-commerce
expected_compose=fdbe323e3f2fadc15a33b9660778e4953992cbb6d9170ade13ef2f3855c91e44
old_image=sha256:9278747d8c7697013eb1c8a1ed31feddb5e5638fbec1d3ec40739d3819bc4272
new_image=${1:?tested image hash required}

test "$(sha256sum "$compose" | cut -d' ' -f1)" = "$expected_compose"
test "$(docker inspect -f '{{.Image}}' parapente-platform-api-1)" = "$old_image"
test "$(docker image inspect -f '{{.Id}}' "$old_tag")" = "$old_image"
test "$(docker image inspect -f '{{.Id}}' "$new_tag")" = "$new_image"
test "$(grep -Ec '^    image: parapente-angola-api:1\.6\.8-jsonb$' "$compose")" = 1
test ! -e "$backup"
db="$(docker inspect -f '{{.Id}}' parapente-platform-db-1)"
rest="$(docker inspect -f '{{.Id}}' parapente-platform-postgrest-1)"
umask 077
install -d -m 700 "$backup"
cp -p "$compose" "$backup/docker-compose.yml"
if [ -f "$project/.env" ]; then install -m 600 "$project/.env" "$backup/.env"; fi
docker exec parapente-platform-db-1 pg_dump -U parapente -d parapente --format=custom > "$backup/parapente-before-commerce.dump"
test -s "$backup/parapente-before-commerce.dump"
docker exec -i parapente-platform-db-1 pg_restore --list < "$backup/parapente-before-commerce.dump" > "$backup/dump.contents"
grep -q ' TABLE public profiles ' "$backup/dump.contents"
sha256sum "$backup/parapente-before-commerce.dump" > "$backup/dump.sha256"
sed 's/^    image: parapente-angola-api:1\.6\.8-jsonb$/    image: parapente-angola-api:1.7.0-commerce/' "$compose" > "$release/compose.next.yml"
docker compose --project-directory "$project" -p parapente-platform -f "$release/compose.next.yml" config --quiet
test "$(sha256sum "$compose" | cut -d' ' -f1)" = "$expected_compose"
echo 'Verified rollback backup in a private directory.'

compose_api() {
  docker compose --project-directory "$project" -p parapente-platform -f "$compose" up -d --no-deps --pull never api
}
rollback() {
  cp -p "$backup/docker-compose.yml" "$compose"
  compose_api
}
cp "$release/compose.next.yml" "$compose"
if ! compose_api; then rollback; exit 1; fi
healthy=false
for attempt in $(seq 1 35); do
  if docker exec parapente-platform-api-1 node -e '
    const base="http://127.0.0.1:8080";
    Promise.all([fetch(base+"/health"),fetch(base+"/catalog/courses"),fetch(base+"/catalog/products"),fetch(base+"/admin/commerce/orders")])
      .then(async ([health,courses,products,admin]) => {
        if (!health.ok || !courses.ok || !products.ok || admin.status!==401) process.exit(1);
        const config=await courses.json(), catalog=await products.json();
        process.exit(typeof config.show_price_table==="boolean" && Array.isArray(config.offers) && Array.isArray(catalog) ? 0 : 1);
      }).catch(()=>process.exit(1));' >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done
if [ "$healthy" != true ] || [ "$(docker inspect -f '{{.Image}}' parapente-platform-api-1)" != "$new_image" ] ||
    [ "$(docker inspect -f '{{.Id}}' parapente-platform-db-1)" != "$db" ] ||
    [ "$(docker inspect -f '{{.Id}}' parapente-platform-postgrest-1)" != "$rest" ]; then
  rollback
  exit 1
fi
docker exec parapente-platform-api-1 node -p '"API " + require("./package.json").version'
echo 'Only the API container changed. PostgreSQL and PostgREST were preserved.'
