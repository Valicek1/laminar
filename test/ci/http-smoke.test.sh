#!/usr/bin/env bash

set -euo pipefail

readonly LAMINARD_BIN="${LAMINARD_BIN:-/build/laminard}"
readonly LAMINARC_BIN="${LAMINARC_BIN:-/build/laminarc}"
readonly SCRATCH_DIR="$(mktemp -d)"
readonly LAMINAR_TEST_HOME="${SCRATCH_DIR}/home"
readonly HTTP_SOCKET="${SCRATCH_DIR}/http.sock"
readonly RPC_SOCKET="${SCRATCH_DIR}/rpc.sock"
readonly DAEMON_LOG="${SCRATCH_DIR}/laminard.log"

daemon_pid=""

daemon_is_running() {
    local process_state=""

    kill -0 "${daemon_pid}" 2>/dev/null || return 1
    if [[ -r "/proc/${daemon_pid}/stat" ]]; then
        read -r _ _ process_state _ < "/proc/${daemon_pid}/stat" || return 1
        [[ "${process_state}" != 'Z' ]]
    fi
}

cleanup() {
    local attempt

    if [[ -n "${daemon_pid}" ]]; then
        kill "${daemon_pid}" 2>/dev/null || true
        for ((attempt = 0; attempt < 50; attempt++)); do
            daemon_is_running || break
            sleep 0.05
        done
        if daemon_is_running; then
            kill -KILL "${daemon_pid}" 2>/dev/null || true
        fi
        wait "${daemon_pid}" || true
    fi
    rm -rf -- "${SCRATCH_DIR}" || true
}

fail() {
    printf 'HTTP smoke test failed: %s\n' "$1" >&2
    if [[ -s "${DAEMON_LOG}" ]]; then
        printf '%s\n' '--- laminard output ---' >&2
        sed -n '1,200p' "${DAEMON_LOG}" >&2
    fi
    exit 1
}

assert_http_resource() {
    local path="$1"
    local content_type="$2"
    local marker="$3"
    local headers="${SCRATCH_DIR}/headers"
    local body="${SCRATCH_DIR}/body"

    curl --silent --show-error --fail --compressed \
        --connect-timeout 2 --max-time 5 \
        --unix-socket "${HTTP_SOCKET}" \
        --dump-header "${headers}" \
        --output "${body}" \
        "http://localhost${path}" \
        || fail "GET ${path} did not succeed"

    grep -Fqi "content-type: ${content_type}" "${headers}" \
        || fail "GET ${path} returned an unexpected content type"
    grep -Fq "${marker}" "${body}" \
        || fail "GET ${path} did not contain ${marker}"
}

trap cleanup EXIT

mkdir -p "${LAMINAR_TEST_HOME}/cfg/jobs" "${LAMINAR_TEST_HOME}/cfg/contexts"
printf '%s\n' '#!/bin/sh' 'printf "smoke-log\\n"' \
    > "${LAMINAR_TEST_HOME}/cfg/jobs/smoke.run"
chmod +x "${LAMINAR_TEST_HOME}/cfg/jobs/smoke.run"
printf '%s\n' 'EXECUTORS=1' \
    > "${LAMINAR_TEST_HOME}/cfg/contexts/default.conf"

LAMINAR_HOME="${LAMINAR_TEST_HOME}" \
LAMINAR_BIND_HTTP="unix:${HTTP_SOCKET}" \
LAMINAR_BIND_RPC="unix:${RPC_SOCKET}" \
    "${LAMINARD_BIN}" > "${DAEMON_LOG}" 2>&1 &
daemon_pid=$!

ready=false
readonly READY_DEADLINE=$((SECONDS + 5))
while ((SECONDS < READY_DEADLINE)); do
    if curl --silent --fail --connect-timeout 1 --max-time 1 \
        --unix-socket "${HTTP_SOCKET}" \
        --output /dev/null http://localhost/; then
        ready=true
        break
    fi
    kill -0 "${daemon_pid}" 2>/dev/null \
        || fail 'laminard exited before its HTTP endpoint became ready'
    sleep 0.05
done
[[ "${ready}" == true ]] || fail 'laminard HTTP endpoint did not become ready'

assert_http_resource '/' 'text/html; charset=utf-8' '<title>Laminar</title>'
assert_http_resource '/js/app.js' 'application/javascript; charset=utf-8' 'const Charts'
assert_http_resource '/js/logview.js' 'application/javascript; charset=utf-8' 'createAutoScrollController'
assert_http_resource '/js/Chart.min.js' 'application/javascript; charset=utf-8' 'Chart'
assert_http_resource '/style.css' 'text/css; charset=utf-8' '.console-log'

if ! run_id="$(LAMINAR_HOST="unix:${RPC_SOCKET}" \
    timeout --kill-after=2s 15s "${LAMINARC_BIN}" run smoke)"; then
    fail 'laminarc did not complete the smoke job within 15 seconds'
fi
[[ "${run_id}" == 'smoke:1' ]] \
    || fail "laminarc returned unexpected run id: ${run_id}"

assert_http_resource '/log/smoke/1' 'text/plain; charset=utf-8' 'smoke-log'

sse_body="${SCRATCH_DIR}/status.sse"
sse_error="${SCRATCH_DIR}/status.stderr"
set +e
curl --silent --show-error --no-buffer --connect-timeout 2 --max-time 5 \
    --unix-socket "${HTTP_SOCKET}" \
    --header 'Accept: text/event-stream' \
    --output "${sse_body}" \
    http://localhost/jobs/smoke 2> "${sse_error}"
curl_status=$?
set -e

if ((curl_status != 0 && curl_status != 28)); then
    sed -n '1,20p' "${sse_error}" >&2
    fail "status stream failed with curl exit code ${curl_status}"
fi
grep -Fq '"type":"status"' "${sse_body}" \
    || fail 'status stream did not contain a status event'
grep -Fq '"number":1' "${sse_body}" \
    || fail 'status stream did not contain run number 1'
grep -Fq '"result":"success"' "${sse_body}" \
    || fail 'status stream did not report a successful run'

printf '%s\n' 'HTTP smoke test passed'
