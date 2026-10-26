#!/usr/bin/env bash
set -u

usage() {
  cat <<'EOF'
Usage: ./afk.sh [--max-iterations COUNT] PROMPT_FILE

Run one Codex coding-task session at a time using the code skill.
COUNT is the maximum number of session launches, including retries (default: 10).

Exit status: 0 on completion, 1 on a blocker or other unsuccessful stop,
130 when interrupted.
EOF
}

error() {
  printf 'afk: %s\n' "$*" >&2
  exit 1
}

max_iterations=10
prompt_file=

while (($#)); do
  case $1 in
    -h|--help)
      usage
      exit 0
      ;;
    --max-iterations)
      (($# >= 2)) || error '--max-iterations needs a count'
      max_iterations=$2
      shift 2
      ;;
    --max-iterations=*)
      max_iterations=${1#*=}
      shift
      ;;
    --*)
      error "unknown option: $1"
      ;;
    *)
      [[ -z $prompt_file ]] || error 'provide exactly one prompt file'
      prompt_file=$1
      shift
      ;;
  esac
done

[[ $max_iterations =~ ^[1-9][0-9]*$ ]] || error 'max iterations must be a positive integer'
(( ${#max_iterations} <= 18 )) || error 'max iterations is too large'
[[ -n $prompt_file ]] || error 'provide a prompt file'
[[ -f $prompt_file && -r $prompt_file ]] || error "cannot read prompt file: $prompt_file"
LC_ALL=C grep -q '[^[:space:]]' "$prompt_file" || error 'prompt file is empty'
command -v codex >/dev/null 2>&1 || error 'codex CLI is not installed'
command -v jq >/dev/null 2>&1 || error 'jq is required to validate the response protocol'

last_message=$(mktemp "${TMPDIR:-/tmp}/afk-last-message.XXXXXXXX") || error 'cannot create temporary response file'
codex_pid=

cleanup() {
  rm -f "$last_message"
}

interrupt() {
  trap - INT TERM
  if [[ -n $codex_pid ]] && kill -0 "$codex_pid" 2>/dev/null; then
    kill -INT "$codex_pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$codex_pid" 2>/dev/null; then
      kill -TERM "$codex_pid" 2>/dev/null || true
    fi
    wait "$codex_pid" 2>/dev/null || true
  fi
  printf '\nafk: interrupted\n' >&2
  exit 130
}

trap cleanup EXIT
trap interrupt INT TERM

send_prompt() {
  cat <<'EOF'
Use the available code skill for this iteration. 
---
EOF
  cat "$prompt_file"
}

validate_response() {
  jq -s -er '
    if length != 1 or (.[0] | type) != "object" then error("expected one JSON object")
    else .[0] end
    | if (.outcome == "repeat" or .outcome == "complete") and (keys == ["outcome"])
      then .outcome
      elif .outcome == "blocked" and (keys == ["blocker_text", "outcome"])
           and (.blocker_text | type == "string" and length > 0)
      then .outcome
      elif .outcome == "fail" and (keys == ["failure_summary", "outcome"])
           and (.failure_summary | type == "string" and length > 0)
      then .outcome
      else error("invalid coding-loop response") end
  ' "$last_message" 2>/dev/null
}

consecutive_errors=0
for ((iteration=1; iteration<=max_iterations; iteration++)); do
  : > "$last_message"
  printf 'afk: iteration %d/%d\n' "$iteration" "$max_iterations" >&2

  codex exec --approve-for-me --output-last-message "$last_message" - < <(send_prompt) &
  codex_pid=$!
  if wait "$codex_pid"; then
    exit_status=0
  else
    exit_status=$?
  fi
  codex_pid=

  execution_error=
  outcome=
  if ((exit_status != 0)); then
    execution_error="Codex exited with status $exit_status"
  elif [[ ! -s $last_message ]]; then
    execution_error='Codex returned no final response'
  elif ! outcome=$(validate_response); then
    execution_error='Codex returned an invalid final response'
  fi

  if [[ -n $execution_error ]]; then
    printf 'afk: execution error: %s\n' "$execution_error" >&2
    ((consecutive_errors += 1))
    if ((consecutive_errors >= 2)); then
      error 'two consecutive execution errors; stopping'
    fi
    if ((iteration == max_iterations)); then
      error "iteration limit reached ($max_iterations) without completion"
    fi
    printf 'afk: retrying in a fresh session\n' >&2
    continue
  fi

  consecutive_errors=0
  case $outcome in
    complete)
      printf 'afk: feature complete\n'
      exit 0
      ;;
    blocked)
      error "blocked: $(jq -r '.blocker_text' "$last_message")"
      ;;
    fail)
      printf 'afk: task failed: %s\n' "$(jq -r '.failure_summary' "$last_message")" >&2
      ;;
    repeat)
      ;;
  esac
done

error "iteration limit reached ($max_iterations) without completion"
