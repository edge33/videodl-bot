#!/bin/sh
set -eu
name="videodl-e2e-$$"
cleanup() {
  docker rm -f "$name-bot" "$name-telegram" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker build -f e2e/Dockerfile -t videodl-bot:e2e .
docker network create --internal "$name" >/dev/null
for scenario in success failure cancel; do
  docker run -d --name "$name-telegram" --network "$name" --network-alias telegram -e SCENARIO="$scenario" --entrypoint node videodl-bot:e2e e2e/telegram.mjs >/dev/null
  docker run -d --name "$name-bot" --network "$name" -e SCENARIO="$scenario" -e TELEGRAM_BOT_API_KEY=123:synthetic -e TELEGRAM_ALLOWED_USER_ID=42 -e TELEGRAM_API_ROOT=http://telegram:8080 -e FREE_SPACE_RESERVE_BYTES=1 videodl-bot:e2e >/dev/null
  ready=false
  for attempt in $(seq 1 60); do
    if docker exec "$name-telegram" node -e "fetch('http://localhost:8080/health').then(r=>r.json()).then(r=>process.exit(r.result ? 0 : 1))"; then ready=true; break; fi
    sleep 1
  done
  if [ "$ready" != true ]; then docker logs "$name-bot"; docker logs "$name-telegram"; exit 1; fi
  docker exec "$name-bot" node --input-type=module -e "
    import assert from 'node:assert/strict';
    import {readdirSync,readFileSync} from 'node:fs';
    import {execFileSync} from 'node:child_process';
    assert.deepEqual(readdirSync('/downloads/.staging'),[]);
    const files=readdirSync('/downloads').filter(f=>f.endsWith('.mp3'));
    assert.equal(files.length,process.env.SCENARIO==='success'?1:0);
    if(files.length) execFileSync('ffprobe',['-v','error','/downloads/'+files[0]]);
    if(process.env.SCENARIO==='cancel') assert.throws(()=>process.kill(Number(readFileSync('/downloads/attempt','utf8')),0));
  "
  docker stop -t 10 "$name-bot" >/dev/null
  docker rm -f "$name-bot" "$name-telegram" >/dev/null
  echo "Passed: $scenario"
done
