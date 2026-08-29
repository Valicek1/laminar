#!/usr/bin/env bash
set -euo pipefail

readonly repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
readonly scratch=$(mktemp -d)
readonly original_path=$PATH
trap 'rm -rf -- "$scratch"' EXIT

mkdir "$scratch/bin"
cat > "$scratch/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "${DOCKER_ARGS_FILE:?}"
printf '%s\n' "$PWD" > "${DOCKER_PWD_FILE:?}"
exit "${DOCKER_EXIT_STATUS:-0}"
EOF
chmod +x "$scratch/bin/docker"

assert_invocation() {
  local expected_base=$1
  local configured_base=${2-}
  local args_file=$scratch/args
  local pwd_file=$scratch/pwd
  local -a actual expected

  if [[ -n $configured_base ]]; then
    (
      cd /tmp
      DOCKER_ARGS_FILE=$args_file \
        DOCKER_PWD_FILE=$pwd_file \
        PATH="$scratch/bin:$original_path" \
        LAMINAR_CI_BASE_IMAGE=$configured_base \
        "$repo_root/.laminar"
    )
  else
    (
      cd /tmp
      DOCKER_ARGS_FILE=$args_file \
        DOCKER_PWD_FILE=$pwd_file \
        PATH="$scratch/bin:$original_path" \
        env -u LAMINAR_CI_BASE_IMAGE "$repo_root/.laminar"
    )
  fi

  mapfile -t actual < "$args_file"
  expected=(
    build
    --build-arg
    "BASE_IMAGE=$expected_base"
    --file
    Dockerfile.ci
    --target
    test
    .
  )

  if ((${#actual[@]} != ${#expected[@]})); then
    printf 'argument count mismatch: expected %d, got %d\n' \
      "${#expected[@]}" "${#actual[@]}" >&2
    return 1
  fi
  for index in "${!expected[@]}"; do
    if [[ ${actual[index]} != "${expected[index]}" ]]; then
      printf 'argument %d mismatch: expected %q, got %q\n' \
        "$index" "${expected[index]}" "${actual[index]}" >&2
      return 1
    fi
  done

  if [[ $(< "$pwd_file") != "$repo_root" ]]; then
    printf 'working directory mismatch: expected %q, got %q\n' \
      "$repo_root" "$(< "$pwd_file")" >&2
    return 1
  fi
}

assert_invocation debian:trixie
assert_invocation \
  registry.sw3.cz/valicek1/lxcbian-trixie \
  registry.sw3.cz/valicek1/lxcbian-trixie

set +e
(
  cd /tmp
  DOCKER_ARGS_FILE=$scratch/args \
    DOCKER_PWD_FILE=$scratch/pwd \
    DOCKER_EXIT_STATUS=23 \
    PATH="$scratch/bin:$original_path" \
    "$repo_root/.laminar"
)
status=$?
set -e
if ((status != 23)); then
  printf 'Docker exit status mismatch: expected 23, got %d\n' "$status" >&2
  exit 1
fi
