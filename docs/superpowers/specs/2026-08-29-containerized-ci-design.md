# Containerized CI Design

## Objective

Add a minimal, self-contained CI entry point to the Laminar repository. The
same Docker build must run both from a Laminar job and from a developer's local
checkout, and it must execute all test suites that already exist in the
repository.

This is the first of several planned CI improvements. HTTP smoke tests,
memory-leak regression tests, CTest integration, coverage reports, and build
artifact export are explicitly deferred.

## Constraints

- The default build environment is the public `debian:trixie` image.
- Callers can replace the base image with any Debian Trixie-compatible image
  that provides `apt-get`, including the internal
  `registry.sw3.cz/valicek1/lxcbian-trixie` image.
- CI and local execution use the same Dockerfile and commands.
- The first version does not change Laminar's CMake test registration or
  production behavior.
- A failed configure, compilation, C++ test, or JavaScript test must make the
  Docker build fail with a non-zero status.

## Architecture

The Laminar repository will contain a `Dockerfile.ci` with a configurable
base-image argument:

```dockerfile
ARG BASE_IMAGE=debian:trixie
FROM ${BASE_IMAGE} AS test
```

The image installs Laminar's existing build dependencies, GoogleTest, and
Node.js. It copies the repository into the image, configures a Release build
with `BUILD_TESTS=TRUE`, compiles it, runs the generated `laminar-tests`
binary, and finally runs every JavaScript test matching
`test/js/*.test.js` through Node's built-in test runner.

A root-level executable `.laminar` script is the CI adapter. It invokes the
same Docker build a developer runs locally and obtains the base image from
`LAMINAR_CI_BASE_IMAGE`, defaulting to `debian:trixie`. Docker's exit status is
propagated unchanged to Laminar.

## Interfaces

The default local command is:

```sh
docker build --file Dockerfile.ci --target test .
```

An alternative base image is selected with:

```sh
docker build \
  --build-arg BASE_IMAGE=registry.sw3.cz/valicek1/lxcbian-trixie \
  --file Dockerfile.ci \
  --target test \
  .
```

The Laminar CI job runs:

```sh
./.laminar
```

and may select the internal base image by setting:

```sh
LAMINAR_CI_BASE_IMAGE=registry.sw3.cz/valicek1/lxcbian-trixie
```

## Build and Test Flow

1. Docker resolves the configured base image.
2. The image installs the C++ compiler, CMake, Make, Cap'n Proto, SQLite,
   Boost, RapidJSON, zlib, GoogleTest, Node.js, Git, CA certificates, and
   supporting package metadata tools.
3. The repository is copied to a fixed source directory in the image.
4. CMake configures an out-of-tree Release build with tests enabled.
5. CMake builds `laminard`, `laminarc`, and `laminar-tests` using the available
   CPU count.
6. The C++ GoogleTest executable runs directly with its normal detailed
   output.
7. Node runs all existing JavaScript tests using `node --test`.
8. Docker reports success only if every preceding step succeeds.

## Error Handling

The `.laminar` script uses strict shell settings and validates no optional
inputs beyond applying the default base image. Missing Docker, an unreachable
base-image registry, dependency installation failures, compile errors, and
test failures remain visible in the Docker output and terminate the job.

No cleanup logic is needed in the first version because Docker owns all build
state. The workflow creates no named containers, volumes, or host-side build
directories.

## Verification

The implementation is accepted when:

- `bash -n .laminar` succeeds;
- `.laminar` is executable;
- `docker build --file Dockerfile.ci --target test .` completes successfully
  with the default public base image;
- the build log proves that both `laminar-tests` and
  `node --test test/js/*.test.js` executed;
- overriding `BASE_IMAGE` reaches the same build and test steps when a
  compatible image is supplied;
- a deliberately failing C++ or JavaScript test would stop the Docker build
  rather than be ignored.

## Deferred Follow-ups

The next phases may register both suites with CTest, add an HTTP smoke test of
the compiled `laminard` and its embedded resources, add browser-side memory
leak regressions, produce C++ and JavaScript coverage reports, and export
coverage or binary artifacts. None of those changes are required for this
first CI bootstrap.
