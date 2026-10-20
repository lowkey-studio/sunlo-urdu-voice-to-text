#!/usr/bin/env bash
# Accuracy check: FLEURS ur_pk test clips (read speech), as clean Opus and with 15 dB noise, through the live API as tests.
set -u
W=$(cd "$(dirname "$0")/../.." && pwd); D=$W/data/private/audio; cd "$D"
[ -s rows.json ] || curl -4 -s -m 120 "https://datasets-server.huggingface.co/rows?dataset=google/fleurs&config=ur_pk&split=test&offset=0&length=30" > rows.json
python3 -I -c "
import json,urllib.request,os;d=json.load(open('rows.json'))
for i,r in enumerate(d['rows']):
  if os.path.exists(f'g{i}.wav'): continue
  a=r['row']['audio'];src=a[0]['src'] if isinstance(a,list) else a['src']
  try: urllib.request.urlretrieve(src,f'g{i}.wav'); open(f'g{i}.txt','w').write(r['row']['transcription'])
  except Exception as e: print('fail',i,e)
"
for f in g*.wav; do b=${f%.wav}; [ -s c_$b.opus ] || uv run -q --no-project --with soundfile --with numpy python -I $W/scripts/eval/mkopus.py $f c_$b.opus 100; [ -s n_$b.opus ] || uv run -q --no-project --with soundfile --with numpy python -I $W/scripts/eval/mkopus.py $f n_$b.opus 15; done
. $W/data/private/keys.env
for kind in c n; do
  out=eval_$kind.jsonl; : > $out
  for t in g*.txt; do b=${t%.txt}; f=${kind}_$b.opus; [ -f $f ] || continue
    r=''; for try in 1 2 3; do r=$(curl -4 -s -m 120 -H "X-Test: $TEST_KEY" -H "Content-Type: audio/ogg" -H "X-Duration: 12" --data-binary @$f https://sunlo-api.appin60.com/api/transcribe); echo "$r" | jq -e .urdu >/dev/null 2>&1 && break; done
    echo "$r" | jq -e . >/dev/null 2>&1 || r=null
    jq -nc --arg id $b --arg ref "$(cat $t)" --argjson r "$r" '{id:$id, ref:$ref, text:($r.urdu // null), roman:($r.roman//null), english:($r.english//null)}' >> $out
  done
  jq -s . $out > eval_$kind.json
  echo "$kind: $(python3 $W/scripts/eval/wer.py eval_$kind.json)"
done
