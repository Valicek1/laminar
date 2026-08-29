# Containerized CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Docker-based Laminar CI entry point that uses a configurable Debian-compatible base image and runs the repository's C++, JavaScript, and CI-wrapper tests identically in CI and local checkouts.

**Architecture:** A root `.laminar` adapter delegates CI execution to a `Dockerfile.ci` test stage. The container installs all native and Node.js dependencies, performs an out-of-tree Release build, then executes the shell contract test, `laminar-tests`, and every `test/js/*.test.js` file; Docker's build status is the CI result.

**Tech Stack:** Bash, Docker/BuildKit, Debian Trixie, CMake, GNU Make, GoogleTest, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-08-29-containerized-ci-design.md`

## Global Constraints

- The default build environment is the public `debian:trixie` image.
- `BASE_IMAGE` must accept any Debian Trixie-compatible image that provides `apt-get`, including `registry.sw3.cz/valicek1/lxcbian-trixie`.
- CI and local execution must use the same `Dockerfile.ci` test target.
- The build must use `CMAKE_BUILD_TYPE=Release` and `BUILD_TESTS=TRUE`.
- Configure, compilation, shell-test, C++-test, and JavaScript-test failures must propagate as a non-zero Docker build status.
- This phase must not change Laminar production behavior, CTest registration, coverage, smoke tests, or build-artifact export.
- Commit only in the nested Laminar repository; do not commit the updated submodule pointer in `laminar-wrap`.

---

### Task 1: Test and implement the Laminar CI entry point

**Files:**
- Create: `.laminar`
- Create: `test/ci/laminar-entrypoint.test.sh`

**Interfaces:**
- Consumes: optional environment variable `LAMINAR_CI_BASE_IMAGE`; executable `docker` resolved through `PATH`.
- Produces: executable `./.laminar`, which passes the selected image as `BASE_IMAGE=$LAMINAR_CI_BASE_IMAGE` to `docker build --file Dockerfile.ci --target test .` from the repository root and returns Docker's exit status.

- [ ] **Step 1: Write the failing shell contract test**

Create `test/ci/laminar-entrypoint.test.sh`:

```bash
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
exit "${DOCKER_EXIT_STATUS:-0}"
EOF
chmod +x "$scratch/bin/docker"

assert_invocation() {
  local expected_base=$1
  local configured_base=${2-}
  local args_file=$scratch/args
  local -a actual expected

  if [[ -n $configured_base ]]; then
    (
      cd /tmp
      DOCKER_ARGS_FILE=$args_file \
        PATH="$scratch/bin:$original_path" \
        LAMINAR_CI_BASE_IMAGE=$configured_base \
        "$repo_root/.laminar"
    )
  else
    (
      cd /tmp
      DOCKER_ARGS_FILE=$args_file \
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
}

assert_invocation debian:trixie
assert_invocation \
  registry.sw3.cz/valicek1/lxcbian-trixie \
  registry.sw3.cz/valicek1/lxcbian-trixie

set +e
(
  cd /tmp
  DOCKER_ARGS_FILE=$scratch/args \
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
```

- [ ] **Step 2: Make the contract test executable and verify RED**

Run:

```bash
chmod +x test/ci/laminar-entrypoint.test.sh
bash test/ci/laminar-entrypoint.test.sh
```

Expected: FAIL because the repository-root `.laminar` executable does not exist. The failure must occur before reading the captured Docker arguments.

- [ ] **Step 3: Implement the minimal CI entry point**

Create `.laminar`:

```bash
#!/usr/bin/env bash
set -euo pipefail

readonly repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly base_image=${LAMINAR_CI_BASE_IMAGE:-debian:trixie}

cd "$repo_root"
exec docker build \
  --build-arg "BASE_IMAGE=$base_image" \
  --file Dockerfile.ci \
  --target test \
  .
```

Run:

```bash
chmod +x .laminar
```

- [ ] **Step 4: Verify GREEN and shell syntax**

Run:

```bash
bash -n .laminar test/ci/laminar-entrypoint.test.sh
bash test/ci/laminar-entrypoint.test.sh
```

Expected: both commands exit 0 with no output. The mock Docker invocation proves the default image, override image, exact CLI arguments, repository-root working directory, and exit-status propagation through `exec`.

- [ ] **Step 5: Commit the entry point and its test in Laminar**

```bash
git add .laminar test/ci/laminar-entrypoint.test.sh
git commit -m "ci: add container test entry point"
```

### Task 2: Build and run every test suite in Docker

**Files:**
- Create: `Dockerfile.ci`
- Modify: `README.md:35`
- Test: `test/ci/laminar-entrypoint.test.sh`
- Test: `test/laminar-functional.cpp`
- Test: `test/unit-conf.cpp`
- Test: `test/unit-database.cpp`
- Test: `test/js/logview.test.js`

**Interfaces:**
- Consumes: Docker build argument `BASE_IMAGE`, defaulting to `debian:trixie`; the repository source tree; `.laminar` from Task 1.
- Produces: Docker target `test`, whose successful build proves configuration, compilation, the shell CI contract, all GoogleTest cases in `/build/laminar-tests`, and all Node test files matching `/src/test/js/*.test.js` passed.

- [ ] **Step 1: Verify the Docker acceptance test is RED**

Run:

```bash
docker build --file Dockerfile.ci --target test .
```

Expected: FAIL because `Dockerfile.ci` does not exist. This is the acceptance test for the new containerized workflow rather than a source-code unit test.

- [ ] **Step 2: Create the minimal configurable test image**

Create `Dockerfile.ci`:

```dockerfile
# syntax=docker/dockerfile:1

ARG BASE_IMAGE=debian:trixie
FROM ${BASE_IMAGE} AS test

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      binutils \
      ca-certificates \
      capnproto \
      cmake \
      g++ \
      git \
      gzip \
      libboost-dev \
      libcapnp-dev \
      libgtest-dev \
      libsqlite3-dev \
      make \
      nodejs \
      pkg-config \
      rapidjson-dev \
      zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

RUN cmake \
      -S . \
      -B /build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_TESTS=TRUE
RUN cmake --build /build --parallel "$(nproc)"

RUN bash test/ci/laminar-entrypoint.test.sh
RUN /build/laminar-tests
RUN node --test test/js/*.test.js
```

- [ ] **Step 3: Run the default public-image build and verify GREEN**

Run:

```bash
docker build --progress=plain --file Dockerfile.ci --target test .
```

Expected: exit 0. The log must contain successful output from:

```text
bash test/ci/laminar-entrypoint.test.sh
/build/laminar-tests
node --test test/js/*.test.js
```

If dependency download is blocked by the execution sandbox, rerun the exact command with approved network access. Fix build or test failures in the narrowest responsible file; do not weaken or skip a failing suite.

- [ ] **Step 4: Verify the base-image argument uses the same pipeline**

Run:

```bash
docker build \
  --progress=plain \
  --build-arg BASE_IMAGE=debian:trixie \
  --file Dockerfile.ci \
  --target test \
  .
```

Expected: exit 0, normally using cached layers from Step 3. This explicit override proves that `BASE_IMAGE` is accepted without requiring credentials for the internal registry; Task 1 separately proves that `.laminar` forwards the internal image name unchanged.

- [ ] **Step 5: Document local and Laminar execution**

Insert this section into `README.md` between "Building from source" and "Packaging for distributions":

````markdown
## Running tests in Docker

The repository includes a self-contained Docker test build that runs the C++
and JavaScript test suites:

```bash
docker build --file Dockerfile.ci --target test .
```

The `.laminar` job entry point runs the same command. A compatible custom
Debian base image can be selected for either local or CI execution:

```bash
LAMINAR_CI_BASE_IMAGE=registry.sw3.cz/valicek1/lxcbian-trixie ./.laminar
```
````

- [ ] **Step 6: Run the complete verification set**

Run:

```bash
bash -n .laminar test/ci/laminar-entrypoint.test.sh
bash test/ci/laminar-entrypoint.test.sh
docker build --progress=plain --file Dockerfile.ci --target test .
git diff --check
git status --short
```

Expected:

- both shell checks exit 0;
- Docker exits 0 after the shell, C++, and JavaScript tests pass;
- `git diff --check` prints nothing;
- `git status --short` lists only `Dockerfile.ci` and `README.md` as Task 2 changes before commit;
- the parent `laminar-wrap` repository has a modified `laminar` submodule pointer but receives no commit.

- [ ] **Step 7: Commit the Docker pipeline and documentation in Laminar**

```bash
git add Dockerfile.ci README.md
git commit -m "ci: run Laminar test suites in Docker"
```

After the commit, run:

```bash
git status --short
git -C .. status --short
```

Expected: the Laminar repository is clean; the parent repository reports only the changed `laminar` submodule and remains uncommitted.
