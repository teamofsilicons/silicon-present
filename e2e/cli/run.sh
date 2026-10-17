#!/usr/bin/env bash
# The `present` CLI end to end, on the CLI lane, against the real local Silicon Accounts test stack.
#
#   e2e/cli/run.sh            build, start the lane (service 4351, converter 4352, Ting stand-in 4353,
#                             database present_cli, data .dev/cli), run every check, stop what it started
#   KEEP=1 e2e/cli/run.sh     leave the lane running afterwards (to poke at it)
#   NO_BUILD=1 e2e/cli/run.sh skip cargo build
#
# Needs: the Accounts test stack from e2e/stack/test-stack.json already running (this never starts, stops or
# reseeds it), Postgres via scripts/dev-db.sh, node + the renderer's node_modules, ffmpeg, jq.
#
# Identities (made on first run, reused after): the Carbon c:cli-owner (signs the CLI in with the device flow) and
# four Silicons in its custody: si:cli-writer (owner of the decks), si:cli-editor (a second Silicon editing at the
# same time), si:cli-viewer and si:cli-commenter (role checks). Each signs in with `present login --slt-stdin`
# under its own SILICON_HOME.
#
# Every check prints ok/FAIL and the suite goes on; the summary lists every failure with what came back.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
STACK="$ROOT/e2e/stack/test-stack.json"
ACCOUNTS_URL="$(jq -r .accounts_public_url "$STACK")"
ACCOUNTS_API="$(jq -r .accounts_api_url "$STACK")"
APP_SECRET="$(jq -r .apps.present.app_secret "$STACK")"
ACCOUNTS_DIR="$(jq -r .accounts_checkout "$STACK")"
TSX="$ACCOUNTS_DIR/testkit/node_modules/.bin/tsx"

SERVICE_PORT=4351
CONVERTER_PORT=4352
TING_PORT=4353
DB=present_cli
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
DATA="$ROOT/.dev/cli"
WORK="$DATA/e2e"
LOGS="$DATA/logs"
export CARGO_TARGET_DIR="$ROOT/target" CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0
PRESENT="$ROOT/target/debug/present"
API="http://127.0.0.1:$SERVICE_PORT"
CONVERTER_SECRET="cli-lane-converter-secret"

export PRESENT_API_URL="$API"
export ACCOUNTS_URL

PIDS=()
PASS=0
FAIL=0
FAILS=()
OUT=""
ERRF="$WORK/last.err"

say() { printf '\n== %s\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); FAILS+=("$1 :: $2"); printf '  FAIL  %s\n        %s\n' "$1" "$2"; }

# run NAME CMD... : expect success; stdout lands in $OUT.
run() {
  local name=$1; shift
  if OUT=$("$@" 2>"$ERRF"); then ok "$name"; return 0; fi
  bad "$name" "$(head -c 600 "$ERRF" | tr '\n' ' ')"
  return 1
}
# denied NAME STATUS CMD... : expect a failure whose HTTP status (or code) is STATUS.
denied() {
  local name=$1 want=$2; shift 2
  if OUT=$("$@" --json 2>"$ERRF"); then bad "$name" "succeeded, expected a refusal ($want): $(head -c 300 <<<"$OUT")"; return 1; fi
  local status code
  status=$(jq -r '.error.status // empty' "$ERRF" 2>/dev/null)
  code=$(jq -r '.error.code // empty' "$ERRF" 2>/dev/null)
  if [[ "$status" == "$want" || "$code" == "$want" ]]; then ok "$name (refused: $code)"; return 0; fi
  bad "$name" "expected $want, got status=$status code=$code: $(head -c 400 "$ERRF" | tr '\n' ' ')"
  return 1
}
# is NAME ACTUAL EXPECTED
is() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }
# has NAME HAYSTACK NEEDLE
has() { if grep -qF -- "$3" <<<"$2"; then ok "$1"; else bad "$1" "[$3] not found in: $(head -c 400 <<<"$2" | tr '\n' ' ')"; fi; }
# magic NAME FILE HEX : the file starts with these bytes
magic() {
  local got
  got=$(xxd -p -l $(( ${#3} / 2 )) "$2" 2>/dev/null)
  if [[ "$got" == "$3" ]]; then ok "$1 ($(wc -c <"$2" | tr -d ' ') bytes)"; else bad "$1" "$2 starts with [$got], expected [$3]"; fi
}
j() { jq -r "$1" <<<"$OUT"; }

as() { local who=$1; shift; SILICON_HOME="$WORK/home-$who" "$PRESENT" "$@"; }
A() { as writer "$@"; }
B() { as editor "$@"; }
V() { as viewer "$@"; }
C() { as commenter "$@"; }
K() { as carbon "$@"; }
N() { as nobody "$@"; }
psql_q() { "$PGBIN/psql" -h 127.0.0.1 -p 5490 -U present -d "$DB" -tAc "$1"; }

cleanup() {
  if [[ "${KEEP:-}" != "1" ]]; then
    for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
    for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && wait "$p" 2>/dev/null; done
  else
    echo "KEEP=1: leaving pids ${PIDS[*]:-} running"
  fi
}
trap cleanup EXIT

wait_http() { # URL SECONDS
  local i
  for ((i = 0; i < $2 * 4; i++)); do curl -s -o /dev/null "$1" && return 0; sleep 0.25; done
  return 1
}
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# ---------------------------------------------------------------------------------------------------------------
say "Setting up the CLI lane"
mkdir -p "$WORK" "$LOGS"
rm -rf "$WORK"/home-* "$WORK"/files "$WORK"/out
mkdir -p "$WORK/files" "$WORK/out"

curl -sf "$ACCOUNTS_API/.well-known/jwks.json" >/dev/null || { echo "The Accounts test stack is not answering at $ACCOUNTS_API. Start it as e2e/stack/test-stack.json says."; exit 2; }

if [[ "${NO_BUILD:-}" != "1" ]]; then
  cargo build -q -p present-cli -p present-service 2>&1 | tail -20
fi
[[ -x "$PRESENT" ]] || { echo "No present binary at $PRESENT"; exit 2; }

scripts/dev-db.sh start >/dev/null
"$PGBIN/dropdb" -h 127.0.0.1 -p 5490 -U present --if-exists "$DB" 2>/dev/null
scripts/dev-db.sh create "$DB" >/dev/null
rm -rf "$DATA/assets" "$DATA/data"
mkdir -p "$DATA/data"

for p in $SERVICE_PORT $CONVERTER_PORT $TING_PORT; do
  port_free "$p" || { echo "Port $p is in use; the CLI lane needs it free (stop what you started there)."; exit 2; }
done

# Ting stand-in (tools/ting-standin) when it exists; otherwise tings are checked in the service's outbox.
TING_URL=""
if [[ -f tools/ting-standin/package.json || -f tools/ting-standin/server.ts || -f tools/ting-standin/server.mjs ]]; then
  ENTRY=$(ls tools/ting-standin/{server.ts,server.mjs,src/server.ts,index.ts,index.mjs} 2>/dev/null | head -1)
  if [[ -n "$ENTRY" ]]; then
    TING_PORT=$TING_PORT PORT=$TING_PORT ACCOUNTS_API_URL="$ACCOUNTS_API" TING_APP_SECRET="$(jq -r .apps.ting.app_secret "$STACK")" \
      "$ROOT/renderer/node_modules/.bin/tsx" "$ENTRY" >"$LOGS/ting.log" 2>&1 &
    PIDS+=($!)
    if wait_http "http://127.0.0.1:$TING_PORT/" 20; then TING_URL="http://127.0.0.1:$TING_PORT"; echo "Ting stand-in on $TING_URL"; else echo "Ting stand-in did not start; see $LOGS/ting.log"; fi
  fi
fi

# Converter.
if [[ -f renderer/src/server.ts ]]; then
  (cd renderer && CONVERTER_PORT=$CONVERTER_PORT CONVERTER_SECRET=$CONVERTER_SECRET CONVERTER_TMP="$DATA/converter-tmp" exec node_modules/.bin/tsx src/server.ts) >"$LOGS/converter.log" 2>&1 &
  PIDS+=($!)
  wait_http "http://127.0.0.1:$CONVERTER_PORT/" 60 && echo "Converter on :$CONVERTER_PORT" || echo "Converter did not answer; see $LOGS/converter.log"
fi

# Service.
env PRESENT_DATABASE_URL="postgres://present@127.0.0.1:5490/$DB" \
  PRESENT_BIND="127.0.0.1:$SERVICE_PORT" PRESENT_PUBLIC_URL="$API" PRESENT_WEB_URL="http://127.0.0.1:4320" \
  PRESENT_DATA_DIR="$DATA/data" ACCOUNTS_URL="$ACCOUNTS_URL" ACCOUNTS_API_URL="$ACCOUNTS_API" PRESENT_APP_SECRET="$APP_SECRET" \
  PRESENT_IRIS_URL="$(jq -r .mock_iris_url "$STACK")" PRESENT_CONVERTER_URL="http://127.0.0.1:$CONVERTER_PORT" CONVERTER_SECRET="$CONVERTER_SECRET" \
  ${TING_URL:+PRESENT_TING_URL="$TING_URL"} RUST_LOG="${RUST_LOG:-info}" \
  "$ROOT/target/debug/present-service" >"$LOGS/service.log" 2>&1 &
PIDS+=($!)
wait_http "$API/v1/me" 60 || { echo "The service did not start; last log lines:"; tail -30 "$LOGS/service.log"; exit 2; }
echo "Service on $API"

# Fixtures: a PNG, an MP4, an MP3, a CSV, an HTML element.
python3 - "$WORK/files/photo.png" <<'PY'
import struct, sys, zlib
w, h = 320, 180
raw = b''.join(b'\x00' + b''.join(bytes(((x * 255) // w, (y * 255) // h, 160)) for x in range(w)) for y in range(h))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
PY
ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=1:size=320x180:rate=10 -pix_fmt yuv420p "$WORK/files/demo.mp4"
ffmpeg -loglevel error -y -f lavfi -i sine=frequency=440:duration=1 "$WORK/files/tone.mp3"
printf 'Quarter,Revenue,Cost\nQ1,10,8\nQ2,12,9\nQ3,15,9\n' >"$WORK/files/numbers.csv"
cat >"$WORK/files/widget.html" <<'EOF'
<div class="w"><h1 id="t">Live widget</h1><div class="bar"></div></div>
EOF
cat >"$WORK/files/widget.css" <<'EOF'
body { margin: 0; font-family: sans-serif; background: #12a594; color: white; }
.w { padding: 40px; } .bar { height: 40px; width: 10%; background: #fff; animation: grow 1s forwards; }
@keyframes grow { to { width: 90%; } }
EOF
cat >"$WORK/files/widget.js" <<'EOF'
document.getElementById('t').textContent = 'Live widget ' + (6 * 7);
EOF

# ---------------------------------------------------------------------------------------------------------------
say "The three commands every Silicon app must pass"
mkdir -p "$WORK/home-nobody"
run "present --help" "$PRESENT" --help && has "help names the workflows" "$OUT" "Common workflows"
run "present accounts --json" N accounts --json && is "accounts app_id" "$(j .app_id)" "present"
run "present login status --json (signed out)" N login status --json && is "signed out reports authenticated:false" "$(j .authenticated)" "false"
run "every subcommand has --help" A slide add --help && has "slide add help has an example" "$OUT" "Example"
run "bundled docs list" N docs && has "docs list getting-started" "$OUT" "getting-started"
run "bundled getting-started" N docs getting-started && has "getting-started explains sign-in" "$OUT" "login --slt-stdin"

say "Identities at the Accounts test stack"
mint() { "$TSX" "$ROOT/e2e/cli/mint.mts" "$@"; }
CARBON_JSON=$(mint carbon --email cli-owner@example.test) || { echo "Could not mint the Carbon"; exit 2; }
CARBON_TOKEN=$(jq -r .access_token <<<"$CARBON_JSON")
CARBON_ID=$(jq -r .id <<<"$CARBON_JSON")
# (macOS ships bash 3.2: no associative arrays, so one variable per Silicon.)
for s in writer editor viewer commenter; do
  J=$(mint silicon --carbon-token "$CARBON_TOKEN" --id "si:cli-$s" --name "CLI $s") || { echo "Could not make si:cli-$s"; exit 2; }
  eval "STK_$s=$(jq -r .stk <<<"$J")"
  eval "UUID_$s=$(jq -r .uuid <<<"$J")"
done
stk() { eval "printf '%s' \"\$STK_$1\""; }

say "Signing in"
for s in writer editor viewer commenter; do
  mkdir -p "$WORK/home-$s"
  SLT=$(mint slt --silicon "si:cli-$s" --stk "$(stk $s)" | jq -r .slt)
  run "si:cli-$s signs in with --slt-stdin" bash -c "printf '%s' '$SLT' | SILICON_HOME='$WORK/home-$s' '$PRESENT' login --slt-stdin --json"
done
run "login status --json (signed in)" A login status --json && is "status says who" "$(j .id)" "si:cli-writer"
is "status says authenticated" "$(j .authenticated)" "true"
SLT=$(mint slt --silicon si:cli-writer --stk "$(stk writer)" | jq -r .slt)
mkdir -p "$WORK/home-positional"
run "positional slt_ sign-in" as positional login "$SLT" --json
mkdir -p "$WORK/home-flag"
SLT=$(mint slt --silicon si:cli-editor --stk "$(stk editor)" | jq -r .slt)
run "--slt sign-in" as flag login --slt "$SLT" --json
denied "a used short-lived token is refused" slt_already_used as flag login --slt "$SLT"
denied "a non-slt token is refused before sending" not_a_short_lived_token as flag login --slt "sar_nope"
# The Carbon signs in with the device flow, approved through its first-party session.
mkdir -p "$WORK/home-carbon"
K login --json >"$WORK/device.out" 2>&1 &
DEV_PID=$!
for i in $(seq 1 40); do grep -q user_code "$WORK/device.out" 2>/dev/null && break; sleep 0.25; done
CODE=$(head -1 "$WORK/device.out" | jq -r .user_code)
run "Carbon approves the device code" mint approve --carbon-token "$CARBON_TOKEN" --code "$CODE"
wait "$DEV_PID"; DEV_STATUS=$?
is "device flow sign-in finishes" "$DEV_STATUS" "0"
run "Carbon login status" K login status --json && is "Carbon signed in" "$(j .id)" "$CARBON_ID"
run "whoami" A whoami --json && is "whoami id" "$(j .id)" "si:cli-writer"
denied "config home refuses a file" not_a_directory A config home "$WORK/files/photo.png"
run "config show" A config show --json && is "config shows the API URL" "$(j .api_url.value)" "$API"

say "Folders and decks"
run "folder new" A folder new "CLI Folder" --json && FOLDER=$(j .id)
run "deck new in the folder" A new "CLI Deck" --folder "$FOLDER" --json && DECK=$(j .id)
is "deck is in the folder" "$(j .folder)" "$FOLDER"
run "list --folder" A list --folder "$FOLDER" --json && is "the folder holds the deck" "$(j '.decks[0].id')" "$DECK"
run "list" A list --json && has "list shows the deck" "$OUT" "$DECK"
run "deck by exact title" A read "CLI Deck" --json && is "title resolves to the id" "$(j .id)" "$DECK"
run "rename" A rename "$DECK" "CLI Deck Renamed" --json && is "renamed" "$(j .title)" "CLI Deck Renamed"
run "theme Ivory" A theme "$DECK" Ivory --heading "Fraunces" --color accent=#b4532a --json
run "theme list" A theme --list --json && is "seven themes" "$(j '.themes | length')" "7"

say "Slides"
run "slide add title" A slide add "$DECK" --layout title --title "Zebra Quarterly" --subtitle "October" --notes "Open warmly" --json && S1=$(j .slide)
run "slide add title-body" A slide add "$DECK" --layout title-body --title "Plan" --body $'Hire\nShip' --json && S2=$(j .slide)
run "slide add blank (media)" A slide add "$DECK" --layout blank --json && S3=$(j .slide)
run "slide add blank (data)" A slide add "$DECK" --layout blank --json && S4=$(j .slide)
run "slide add blank (html)" A slide add "$DECK" --layout blank --json && S5=$(j .slide)
run "slide duplicate" A slide duplicate "$DECK" 2 --json && SDUP=$(j .slide)
run "slide move" A slide move "$DECK" "$SDUP" --first --json
run "slide delete" A slide delete "$DECK" "$SDUP" --json
run "slide skip" A slide skip "$DECK" 4 --json
run "slide skip --off" A slide skip "$DECK" 4 --off --json
run "slide section" A slide section "$DECK" 2 "Plan" --json
run "slide notes set" A slide notes "$DECK" 2 "Pause after Hire" --json
run "slide notes read" A slide notes "$DECK" 2 --json && is "notes read back" "$(j .notes)" "Pause after Hire"
run "slide transition" A slide transition "$DECK" 2 push --duration 500 --direction left --json
run "slide background colour" A slide background "$DECK" 5 "#111214" --json
run "slide layout" A slide layout "$DECK" 3 image-caption --json
run "slide master --hide" A slide master "$DECK" 3 --hide --json

say "Every element kind"
run "add text" A add text "$DECK" 1 "Zebra footnote" --x 140 --y 900 --w 800 --h 80 --size 32 --italic --color "#6f6f78" --json && E_TEXT=$(j .element)
run "add shape" A add shape "$DECK" 2 round-rect --text "Step 1" --fill "#eef1f5" --stroke "#3a5a80" --x 1300 --y 300 --w 400 --h 200 --json && E_SHAPE=$(j .element)
run "add image (uploads the file)" A add image "$DECK" 3 "$WORK/files/photo.png" --alt "Gradient" --x 160 --y 120 --w 640 --h 360 --json && E_IMAGE=$(j .element)
run "add video" A add video "$DECK" 3 "$WORK/files/demo.mp4" --muted --loop --x 900 --y 120 --w 640 --h 360 --json && E_VIDEO=$(j .element)
run "add audio" A add audio "$DECK" 3 "$WORK/files/tone.mp3" --json && E_AUDIO=$(j .element)
run "add table from CSV" A add table "$DECK" 4 --csv "$WORK/files/numbers.csv" --header --x 140 --y 140 --w 900 --h 320 --json && E_TABLE=$(j .element)
run "add chart" A add chart "$DECK" 4 --type column --labels Q1,Q2,Q3 --series "Revenue=10,12,15" --series "Cost=8,9,9@#e5484d" --title "2026" --x 1100 --y 140 --w 700 --h 500 --json && E_CHART=$(j .element)
run "add html from files" A add html "$DECK" 5 --html "$WORK/files/widget.html" --css "$WORK/files/widget.css" --js "$WORK/files/widget.js" --x 160 --y 160 --w 1600 --h 760 --json && E_HTML=$(j .element)
run "add text on the master" A add text "$DECK" 1 "CLI footer" --master --x 1500 --y 1010 --w 380 --h 50 --size 20 --json

say "Reading"
run "read (text)" A read "$DECK"
has "text view shows the title" "$OUT" "Zebra Quarterly"
has "text view shows the notes" "$OUT" "Open warmly"
run "read --json" A read "$DECK" --json
CONTENT="$OUT"
is "five slides" "$(jq '.slides | length' <<<"$CONTENT")" "5"
is "all eight element kinds" "$(jq -c '[.slides[].elements[].kind] | unique' <<<"$CONTENT")" '["audio","chart","html","image","shape","table","text","video"]'
is "image points at an asset" "$(jq -r --arg e "$E_IMAGE" '.slides[].elements[] | select(.id==$e) | .src | startswith("asset:")' <<<"$CONTENT")" "true"
is "html kept its JS" "$(jq -r --arg e "$E_HTML" '.slides[].elements[] | select(.id==$e) | .js' <<<"$CONTENT" | head -1 | cut -c1-23)" "document.getElementById"
is "table has 4 rows" "$(jq -r --arg e "$E_TABLE" '.slides[].elements[] | select(.id==$e) | .rows' <<<"$CONTENT")" "4"
is "section set" "$(jq -r '.slides[1].section' <<<"$CONTENT")" "Plan"
is "master has the footer" "$(jq -r '[.master.elements[] | .text.paragraphs[0].runs[0].text] | index("CLI footer") != null' <<<"$CONTENT")" "true"
run "read --comments" A read "$DECK" --comments
run "slide 4 --json" A slide "$DECK" 4 --json && is "slide 4 has the table and chart" "$(j '[.elements[].kind] | sort | join(",")')" "chart,table"
run "slide 1 (text)" A slide "$DECK" 1 && has "slide view lists the footnote" "$OUT" "$E_TEXT"

say "Editing"
run "set geometry and a style key" A set "$DECK" 2 "$E_SHAPE" x=1280 style.fill=#fff8f5 rotation=3 --json
run "read back the set" A slide "$DECK" 2 --json
is "x changed" "$(jq -r --arg e "$E_SHAPE" '.elements[] | select(.id==$e) | .x' <<<"$OUT")" "1280"
is "style.fill changed, stroke kept" "$(jq -r --arg e "$E_SHAPE" '.elements[] | select(.id==$e) | .style.fill + " " + .style.stroke' <<<"$OUT")" "#fff8f5 #3a5a80"
run "set text by kind:n" A set "$DECK" 1 text:1 'text=Zebra Quarterly Review' --json
run "replace one passage" A replace "$DECK" 1 --find "Quarterly Review" --replace "Quarterly Report" --json
denied "replace a missing passage says text_not_found" text_not_found A replace "$DECK" 1 --find "Nonexistent passage" --replace x
run "replace in notes" A replace "$DECK" 2 --field notes --find "Pause" --replace "Breathe" --json
run "replace in html css" A replace "$DECK" 5 "$E_HTML" --field css --find "#12a594" --replace "#2f5bea" --json
run "front" A front "$DECK" 3 "$E_IMAGE" --json
run "back" A back "$DECK" 3 "$E_IMAGE" --json
printf '[{"op":"update_slide","slide":"%s","set":{"notes":"Raw ops notes"}}]' "$S4" >"$WORK/files/ops.json"
run "edit --ops file" A edit "$DECK" --ops "$WORK/files/ops.json" --summary "Raw ops" --json
run "edit --ops - (stdin)" bash -c "printf '%s' '[{\"op\":\"add_element\",\"slide\":\"$S4\",\"element\":{\"kind\":\"text\",\"x\":10,\"y\":10,\"w\":300,\"h\":60,\"text\":\"Temp box\"}}]' | SILICON_HOME='$WORK/home-writer' '$PRESENT' edit '$DECK' --ops - --json"
TEMP=$(jq -r '.elementsAdded[0].element // empty' <<<"$OUT")
[[ -n "$TEMP" ]] && run "delete element" A delete "$DECK" 4 "$TEMP" --json || bad "delete element" "no element id came back from edit --ops"
run "read after edits" A read "$DECK" --json
is "title text replaced" "$(jq -r '.slides[0].elements[0].text.paragraphs[0].runs[0].text' <<<"$OUT")" "Zebra Quarterly Report"
is "notes replaced" "$(jq -r '.slides[1].notes' <<<"$OUT")" "Breathe after Hire"
is "raw op notes" "$(jq -r '.slides[3].notes' <<<"$OUT")" "Raw ops notes"
is "css replaced" "$(jq -r --arg e "$E_HTML" '.slides[4].elements[] | select(.id==$e) | .css | contains("#2f5bea")' <<<"$OUT")" "true"

say "Seeing"
run "render slide 1" A render "$DECK" 1 -o "$WORK/out/s1.png" --json
magic "slide 1 is a PNG" "$WORK/out/s1.png" "89504e470d0a1a0a"
run "render the html slide after 2 s" A render "$DECK" 5 --at 2000 -o "$WORK/out/s5.png" --json
magic "html slide is a PNG" "$WORK/out/s5.png" "89504e470d0a1a0a"
run "render jpg at 960" A render "$DECK" 4 --width 960 --format jpg -o "$WORK/out/s4.jpg" --json
magic "slide 4 is a JPEG" "$WORK/out/s4.jpg" "ffd8ff"
run "render --all" A render "$DECK" --all -o "$WORK/out/all" --json && is "one image per slide" "$(j '.renders | length')" "5"
python3 -c "
import struct,sys
d=open('$WORK/out/s1.png','rb').read(); w,h=struct.unpack('>II',d[16:24]); print(w,h)" >"$WORK/out/s1.size" 2>/dev/null
is "slide 1 PNG is 1920x1080" "$(cat "$WORK/out/s1.size")" "1920 1080"

say "Sharing and roles"
run "share with si:cli-editor as editor" A share "$DECK" si:cli-editor --role editor --json
run "share with si:cli-viewer as viewer" A share "$DECK" si:cli-viewer --role viewer --json
run "share with si:cli-commenter as commenter" A share "$DECK" si:cli-commenter --role commenter --json
run "share with the Carbon as commenter" A share "$DECK" "$CARBON_ID" --role commenter --json
run "share with an email not on Accounts" A share "$DECK" "cli-newcomer@example.test" --role viewer --json && is "email invite is pending" "$(j .pending)" "true"
run "access" A access "$DECK" --json && is "five members" "$(j '.members | length')" "5"
run "viewer reads" V read "$DECK" --json
run "viewer sees it in shared" V list --shared --json && has "shared list has the deck" "$OUT" "$DECK"
denied "viewer can't edit" 403 V set "$DECK" 1 "$E_TEXT" x=1
denied "viewer can't comment" 403 V comment "$DECK" --slide 1 "Viewer comment"
run "commenter comments" C comment "$DECK" --slide 1 "Commenter comment" --json && C_THREAD=$(j .id)
denied "commenter can't edit" 403 C set "$DECK" 1 "$E_TEXT" x=1
denied "commenter can't share" 403 C share "$DECK" si:cli-viewer --role editor
run "editor edits" B set "$DECK" 2 "$E_SHAPE" y=320 --json
run "unshare the email invite" A unshare "$DECK" "cli-newcomer@example.test" --json

say "Working in a folder: pull, concurrent edit, push"
PULL="$WORK/pulled"
rm -rf "$PULL"
run "pull" A pull "$DECK" "$PULL" --json && PULLED_AT=$(j .version)
[[ -f "$PULL/deck.json" && -f "$PULL/.present/base.json" && -d "$PULL/assets" ]] && ok "pull wrote deck.json, base and assets" || bad "pull layout" "$(ls -R "$PULL" | head -30)"
HTML_FILE=$(ls "$PULL"/slides/05-*/"$E_HTML".html 2>/dev/null | head -1)
[[ -n "$HTML_FILE" ]] && ok "html element is its own file" || bad "html element is its own file" "$(ls "$PULL"/slides/*)"
ls "$PULL"/assets | grep -q . && ok "assets downloaded" || bad "assets downloaded" "empty assets/"
run "status: clean after pull" A status "$PULL" --json && is "no changes" "$(j .changed)" "false"
# Local edits: title text (slide 1), the HTML file, notes on slide 1, a new element, and a new slide directory.
S1DIR=$(ls -d "$PULL"/slides/01-* | head -1)
python3 - "$S1DIR/slide.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p))
s["elements"][0]["text"] = "Zebra Quarterly Report (pushed)"
s["notes"] = "Notes from the folder"
s["elements"].append({"kind": "text", "x": 140, "y": 760, "w": 900, "h": 80, "text": "Added in the folder"})
json.dump(s, open(p, "w"), indent=2)
PY
printf '<div class="w"><h1 id="t">Pushed widget</h1><div class="bar"></div></div>\n' >"$HTML_FILE"
mkdir -p "$PULL/slides/06-new"
cat >"$PULL/slides/06-new/slide.json" <<'EOF'
{ "layout": "title-only", "notes": "", "elements": [ { "kind": "text", "x": 140, "y": 80, "w": 1640, "h": 170, "text": "Slide made in a folder" } ] }
EOF
run "status shows the local changes" A status "$PULL" --json && is "changed" "$(j .changed)" "true"
has "status lists the html change" "$(j '.changes | join("\n")')" "$E_HTML"
# Meanwhile the other Silicon changes slide 2 through the API.
run "concurrent edit by si:cli-editor" B replace "$DECK" 2 --find "Plan" --replace "Plan B" --json
run "push merges onto the newer deck" A push "$PULL" --summary "Folder edits" --json && has "push printed what it pushed" "$(j '.changes | join("\n")')" "add slide"
is "push was written against the pulled version" "$(j .base)" "$PULLED_AT"
run "read after push" A read "$DECK" --json
is "folder title change landed" "$(jq -r '.slides[0].elements[0].text.paragraphs[0].runs[0].text' <<<"$OUT")" "Zebra Quarterly Report (pushed)"
is "concurrent API change survived" "$(jq -r '.slides[1].elements[0].text.paragraphs[0].runs[0].text' <<<"$OUT")" "Plan B"
is "html file change landed" "$(jq -r --arg e "$E_HTML" '.slides[4].elements[] | select(.id==$e) | .html | contains("Pushed widget")' <<<"$OUT")" "true"
is "new slide from a directory" "$(jq -r '.slides[5].elements[0].text.paragraphs[0].runs[0].text' <<<"$OUT")" "Slide made in a folder"
is "notes from the folder" "$(jq -r '.slides[0].notes' <<<"$OUT")" "Notes from the folder"
run "status clean after push (folder refreshed)" A status "$PULL" --json && is "no changes after push" "$(j .changed)" "false"
run "push with nothing to push" A push "$PULL" --json && is "nothing pushed" "$(j .pushed)" "false"
python3 - "$S1DIR/slide.json" <<'PY'
import json, sys; p = sys.argv[1]; s = json.load(open(p)); s["notes"] = "unpushed"; json.dump(s, open(p, "w"))
PY
denied "pull refuses to overwrite local changes" local_changes A pull "$DECK" "$PULL"
run "pull --force" A pull "$DECK" "$PULL" --force --json
echo '{ broken' >"$S1DIR/slide.json"
denied "push stops on a broken file" invalid_json A push "$PULL"
run "pull --force repairs it" A pull "$DECK" "$PULL" --force --json

say "Comments"
run "comment on the deck" A comment "$DECK" --deck "Deck-wide note" --json && T_DECK=$(j .id)
run "comment on a slide" A comment "$DECK" --slide 2 "Slide note" --json
run "comment on a point" A comment "$DECK" --slide 1 --point 960,540 "Point note" --json
run "comment on an area of an element, mentioning si:cli-editor" A comment "$DECK" --slide 4 --element "$E_CHART" --area 1150,200,300,200 "@si:cli-editor make this simpler" --json && T_AREA=$(j .id)
is "area anchor kept" "$(j .anchor.kind)" "area"
run "comment on an element (html)" A comment "$DECK" --slide 5 --element "$E_HTML" "Widget note" --json
run "comment on text, mentioning the Carbon" A comment "$DECK" --slide 1 --element text:1 --text "Zebra" "@$CARBON_ID is Zebra right?" --json && T_TEXT=$(j .id)
is "text anchor quote" "$(j .anchor.quote)" "Zebra"
run "reply" B reply "$T_AREA" "Simplified it" --json && C_REPLY=$(j .id)
run "react" K react "$C_REPLY" "👍" --json
run "react --remove" K react "$C_REPLY" "👍" --remove --json
run "react again" K react "$C_REPLY" "🎉" --json
run "comment edit" B comment edit "$C_REPLY" "Simplified it (edited)" --json
run "resolve" A resolve "$T_AREA" --json
run "comments (open)" A comments "$DECK" --json && OPEN_N=$(j '.threads | length')
run "comments --resolved" A comments "$DECK" --resolved --json && is "one resolved thread" "$(j '.threads | length')" "1"
run "reopen" A reopen "$T_AREA" --json
run "comments --all" A comments "$DECK" --all --json && is "seven threads in all" "$(j '.threads | length')" "7"
is "edited reply text" "$(jq -r --arg t "$T_AREA" '.threads[] | select(.id==$t) | .comments[1].body' <<<"$OUT")" "Simplified it (edited)"
run "comment delete" A comment delete "$(jq -r --arg t "$T_DECK" '.threads[] | select(.id==$t) | .comments[0].id' <<<"$OUT")" --json
run "comments in the text view" A read "$DECK" --comments && has "text view shows a thread" "$OUT" "make this simpler"
run "Carbon (commenter) comments" K comment "$DECK" --slide 3 "Carbon note" --json
sleep 2
if [[ -n "$TING_URL" ]]; then
  TINGS=$(curl -s "$TING_URL/tings" || curl -s "$TING_URL/_tings")
  has "Ting stand-in got present.mention.received" "$TINGS" "present.mention.received"
  has "the mention went to si:cli-editor" "$TINGS" "$UUID_editor"
else
  OUTBOX=$(psql_q "select type || ' ' || recipient || ' ' || state from ting_outbox order by id")
  has "outbox has present.mention.received for si:cli-editor" "$OUTBOX" "present.mention.received $UUID_editor"
  has "outbox has present.comment.created for the owner" "$OUTBOX" "present.comment.created $UUID_writer"
  has "outbox has present.comment.replied" "$OUTBOX" "present.comment.replied"
  has "outbox has present.thread.resolved" "$OUTBOX" "present.thread.resolved"
  has "outbox has present.deck.shared for si:cli-viewer" "$OUTBOX" "present.deck.shared $UUID_viewer"
  echo "        (no Ting stand-in at tools/ting-standin: checked the service's ting_outbox)"
fi

say "Public links"
run "public view" A public "$DECK" view --json
run "anyone reads a public deck without signing in" N read "$DECK" --json && is "anonymous read" "$(j .id)" "$DECK"
run "anyone renders a public deck" N render "$DECK" 1 -o "$WORK/out/public.png" --json
run "unshare the commenter" A unshare "$DECK" si:cli-commenter --json
denied "unshared commenter can't comment on a view-only public deck" 403 C comment "$DECK" --slide 1 "x"
run "public edit" A public "$DECK" edit --json
run "signed-in stranger edits through the edit link" C set "$DECK" 1 "$E_TEXT" y=905 --json
run "public off" A public "$DECK" off --json
denied "the link stops working" 404 N read "$DECK"

say "Versions"
run "versions" A versions "$DECK" --json && NV=$(j '.versions | length')
[[ "${NV:-0}" -ge 3 ]] && ok "history has $NV versions" || bad "history" "only ${NV:-0} versions"
CUR=$(A read "$DECK" --json | jq -r .version)
run "version name" A version name "$DECK" "$CUR" "Before restores" --json
run "versions show the name" A versions "$DECK" --json && has "named version listed" "$OUT" "Before restores"
run "read an old version" A read "$DECK" --version "$PULLED_AT" --json && is "old version has 5 slides" "$(j '.slides | length')" "5"
run "compare" A compare "$DECK" "$PULLED_AT" "$CUR" --json && has "compare names the added slide" "$(j '.diff.slidesAdded | length')" "1"
run "compare (text)" A compare "$DECK" "$PULLED_AT" "$CUR"
run "restore one slide" A restore "$DECK" "$PULLED_AT" --slide 1 --json
run "read after slide restore" A read "$DECK" --json
is "slide 1 title is back to the pulled version" "$(jq -r '.slides[0].elements[0].text.paragraphs[0].runs[0].text' <<<"$OUT")" "Zebra Quarterly Report"
is "the rest kept (6 slides)" "$(jq '.slides | length' <<<"$OUT")" "6"
BEFORE_B=$(A read "$DECK" --json | jq -r .version)
run "si:cli-editor changes slide 2" B replace "$DECK" 2 --find "Plan B" --replace "Plan C" --json
run "undo everything si:cli-editor did since" A undo-account "$DECK" si:cli-editor --since "$BEFORE_B" --json
run "read after undo-account" A read "$DECK" --json
is "si:cli-editor's change is undone" "$(jq -r '.slides[1].elements[0].text.paragraphs[0].runs[0].text' <<<"$OUT")" "Plan B"
run "restore the whole named version" A restore "$DECK" "$CUR" --json
run "new deck from an old version" A new "CLI Deck at pull" --from "$DECK@$PULLED_AT" --json && OLDCOPY=$(j .id)
run "the copy has the old slides" A read "$OLDCOPY" --json && is "copy has 5 slides" "$(j '.slides | length')" "5"

say "Export every format"
for f in pptx ppt key odp pdf html png jpg; do
  if run "export $f" A export "$DECK" --format "$f" -o "$WORK/out/deck.$f" --json; then
    case $f in
      pptx|odp|png|jpg) magic "$f file is a zip" "$WORK/out/deck.$f" "504b0304" ;;
      ppt) magic "ppt file is OLE2" "$WORK/out/deck.$f" "d0cf11e0a1b11ae1" ;;
      key) magic "key file is a zip (Keynote package)" "$WORK/out/deck.$f" "504b0304" ;;
      pdf) magic "pdf file" "$WORK/out/deck.$f" "25504446" ;;
      html) has "html export is a page" "$(head -c 400 "$WORK/out/deck.$f" | tr 'A-Z' 'a-z')" "<html" ;;
    esac
  fi
done
unzip -l "$WORK/out/deck.png" 2>/dev/null | grep -c '\.png' | tr -d ' ' >"$WORK/out/png.count"
is "png zip has one image per slide" "$(cat "$WORK/out/png.count")" "6"
unzip -p "$WORK/out/deck.odp" mimetype 2>/dev/null >"$WORK/out/odp.mime"
is "odp mimetype" "$(cat "$WORK/out/odp.mime")" "application/vnd.oasis.opendocument.presentation"
run "export one slide as png" A export "$DECK" --format png --slide 1 -o "$WORK/out/one.png" --json && magic "single-slide png" "$WORK/out/one.png" "89504e470d0a1a0a"
run "export an old version" A export "$DECK" --format pdf --version "$PULLED_AT" -o "$WORK/out/old.pdf" --json && magic "old version pdf" "$WORK/out/old.pdf" "25504446"
run "open the pptx again (re-import)" A open "$WORK/out/deck.pptx" --json && REIMPORT=$(j .id)
run "re-imported deck reads" A read "$REIMPORT" --json && is "re-import keeps 6 slides" "$(j '.slides | length')" "6"
has "re-import keeps the title text" "$OUT" "Zebra"
run "open --into a deck" A open "$WORK/out/deck.pptx" --into "$OLDCOPY" --json
run "the deck took the file as its next version" A read "$OLDCOPY" --json && is "6 slides after open --into" "$(j '.slides | length')" "6"
run "open an image as a deck" A open "$WORK/files/photo.png" --json

say "Presenting and following along"
run "start" A start "$DECK" --json && PRES=$(j .id) && FOLLOW=$(j .followUrl)
has "start prints a follow link" "$FOLLOW" "$PRES"
K follow "$PRES" --json --for 30 >"$WORK/out/follow.jsonl" 2>"$WORK/out/follow.err" &
FOLLOW_PID=$!
B watch "$DECK" --json --here 2 --for 30 --until comments >"$WORK/out/watch.jsonl" 2>"$WORK/out/watch.err" &
WATCH_PID=$!
sleep 2
run "next" A next --json
run "next again" A next --json
run "prev" A prev --json
run "goto 4" A goto 4 --json
run "show status" A show status --json && has "status is on slide 4" "$OUT" "$(jq -r '.slides[3].id' <<<"$(A read "$DECK" --json)")"
run "a change while watching" A set "$DECK" 1 "$E_TEXT" x=150 --json
run "a comment ends the watch" A comment "$DECK" --slide 2 "Watched comment" --json
run "stop" A stop --json
wait "$FOLLOW_PID" 2>/dev/null; wait "$WATCH_PID" 2>/dev/null
has "follower saw state changes" "$(cat "$WORK/out/follow.jsonl")" '"event":"state"'
has "follower saw the end" "$(cat "$WORK/out/follow.jsonl")" '"event":"ended"'
has "watch got the sync" "$(cat "$WORK/out/watch.jsonl")" '"event":"sync"'
has "watch got the update with its author" "$(cat "$WORK/out/watch.jsonl")" 'si:cli-writer'
has "watch got the comment" "$(cat "$WORK/out/watch.jsonl")" '"event":"comments"'
has "watch saw si:cli-editor's own presence" "$(cat "$WORK/out/watch.jsonl")" '"event":"presence"'
denied "next after stop has no presentation" no_presentation A next

say "Transfers"
run "make a deck to give away" A new "CLI Gift" --json && GIFT=$(j .id)
run "transfer to si:cli-editor" A transfer "$GIFT" si:cli-editor --json && TR=$(j .id)
run "receiver sees it" B transfers --json && is "incoming transfer" "$(j '.incoming[0].id')" "$TR"
run "accept" B transfers accept "$TR" --json
run "the deck is the receiver's now" B list --json && has "receiver lists the gift" "$OUT" "$GIFT"
run "make a second deck" A new "CLI Declined" --json && GIFT2=$(j .id)
run "transfer to the Carbon" A transfer "$GIFT2" "$CARBON_ID" --json && TR2=$(j .id)
run "Carbon declines" K transfers decline "$TR2" --json
run "make a third deck" A new "CLI Cancelled" --json && GIFT3=$(j .id)
run "transfer it" A transfer "$GIFT3" si:cli-viewer --json && TR3=$(j .id)
run "giver cancels" A transfers cancel "$TR3" --json
run "folder transfer" A transfer "$FOLDER" si:cli-editor --folder --json

say "Folders"
run "folder rename" A folder rename "$FOLDER" "CLI Folder Renamed" --json && is "folder renamed" "$(j .name)" "CLI Folder Renamed"
run "folder new (child)" A folder new "Child" --parent "$FOLDER" --json && CHILD=$(j .id)
run "folder move to root" A folder move "$CHILD" root --json
run "folder share" A folder share "$FOLDER" si:cli-viewer --role viewer --json
run "viewer sees the folder" V folder list --shared --json && has "shared folder listed" "$OUT" "$FOLDER"
run "folder list" A folder list --json && has "child listed" "$OUT" "$CHILD"
run "move a deck out of the folder" A move "$DECK" root --json && is "deck at top level" "$(j .folder)" "null"
run "folder trash" A folder trash "$CHILD" --json
run "folder list --trash" A folder list --trash --json && has "child in the trash" "$OUT" "$CHILD"
run "folder untrash" A folder untrash "$CHILD" --json

say "Search"
run "search" A search "Zebra" --json && has "search finds the deck" "$OUT" "$DECK"
run "search (text)" A search "Zebra"

say "Trash and permanent delete"
run "trash" A trash "$GIFT3" --json
run "list --trash" A list --trash --json && has "deck in the trash" "$OUT" "$GIFT3"
run "untrash" A untrash "$GIFT3" --json
denied "permanent delete needs the trash" deck_not_in_trash A delete "$GIFT3" --permanent --confirm "CLI Cancelled"
run "trash again" A trash "$GIFT3" --json
denied "permanent delete without a terminal asks for --confirm" confirmation_needed A delete "$GIFT3" --permanent </dev/null
denied "a wrong confirmation is refused" confirmation_required A delete "$GIFT3" --permanent --confirm "Wrong title"
run "permanent delete with --confirm" A delete "$GIFT3" --permanent --confirm "CLI Cancelled" --json
denied "the deck is gone for good" 404 A read "$GIFT3"

say "Errors read like a programming language"
denied "unknown deck" 404 A read "zzzzzzzzzzzz"
denied "unknown slide lists what exists" slide_not_found A slide "$DECK" 99
denied "unknown element lists what exists" element_not_found A set "$DECK" 1 e_nope00 x=1
denied "bad ops are explained" invalid_ops A edit "$DECK" --ops "$WORK/files/numbers.csv"
denied "unreachable service" connection_failed A list --api-url http://127.0.0.1:9
A read zzzzzzzzzzzz 2>&1 >/dev/null | head -3 >"$WORK/out/human-error.txt"
has "human error has a hint line" "$(cat "$WORK/out/human-error.txt")" "hint:"

say "Reports and signing out"
run "report" A report "CLI e2e: report command works" --json
run "logout" B logout --json && is "signed out" "$(j .signed_out)" "true"
run "status after logout" B login status --json && is "authenticated false after logout" "$(j .authenticated)" "false"
denied "commands after logout say to sign in" not_signed_in B list

# ---------------------------------------------------------------------------------------------------------------
cp "$WORK/out/s1.png" "$WORK/out/s5.png" "$DATA/" 2>/dev/null
say "Summary: $PASS passed, $FAIL failed"
if ((FAIL > 0)); then
  for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
  echo "Logs: $LOGS"
  exit 1
fi
echo "Logs: $LOGS   Renders: $WORK/out"
