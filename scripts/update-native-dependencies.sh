#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
VERSION_FILE="${REPOSITORY_ROOT}/cmake/DependencyVersions.cmake"

dependency_names=("QuickJS" "libuv" "Brotli")
dependency_variables=("DIMINA_QUICKJS_GIT_TAG_DEFAULT" "DIMINA_LIBUV_GIT_TAG_DEFAULT" "DIMINA_BROTLI_GIT_TAG_DEFAULT")
dependency_repositories=("https://github.com/bellard/quickjs.git" "https://github.com/libuv/libuv.git" "https://github.com/google/brotli.git")

usage() {
    echo "Usage: $0 [--check|--update]"
    echo "  --check   Fail if any pinned native dependency is not upstream master."
    echo "  --update  Update all pinned native dependencies to upstream master (default)."
}

mode="${1:---update}"
case "${mode}" in
    --check|--update)
        ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac

latest_shas=()
dependencies_outdated=false

for dependency_index in "${!dependency_names[@]}"; do
    dependency_name="${dependency_names[dependency_index]}"
    dependency_variable="${dependency_variables[dependency_index]}"
    dependency_repository="${dependency_repositories[dependency_index]}"

    current_sha=$(sed -n "s/^set(${dependency_variable} \"\\([0-9a-f]\\{40\\}\\)\")$/\\1/p" "${VERSION_FILE}")
    if [[ ! "${current_sha}" =~ ^[0-9a-f]{40}$ ]]; then
        echo "Unable to read the pinned ${dependency_name} commit from ${VERSION_FILE}" >&2
        exit 1
    fi

    latest_sha=$(git ls-remote "${dependency_repository}" refs/heads/master | awk 'NR == 1 { print $1 }')
    if [[ ! "${latest_sha}" =~ ^[0-9a-f]{40}$ ]]; then
        echo "Unable to resolve ${dependency_name} upstream master from ${dependency_repository}" >&2
        exit 1
    fi

    latest_shas+=("${latest_sha}")

    if [[ "${current_sha}" == "${latest_sha}" ]]; then
        echo "${dependency_name} is up to date: ${current_sha}"
    else
        dependencies_outdated=true
        echo "${dependency_name} is outdated: ${current_sha} -> ${latest_sha}"
    fi
done

if [[ "${dependencies_outdated}" == false ]]; then
    exit 0
fi

if [[ "${mode}" == "--check" ]]; then
    echo "Run ./scripts/update-native-dependencies.sh, test both native SDKs, and commit the version updates before releasing." >&2
    exit 1
fi

for dependency_index in "${!dependency_names[@]}"; do
    dependency_variable="${dependency_variables[dependency_index]}"
    latest_sha="${latest_shas[dependency_index]}"
    temporary_file=$(mktemp "${VERSION_FILE}.XXXXXX")
    trap 'rm -f "${temporary_file}"' EXIT

    awk -v dependency_variable="${dependency_variable}" -v latest_sha="${latest_sha}" '
        index($0, "set(" dependency_variable " \"") == 1 {
            print "set(" dependency_variable " \"" latest_sha "\")"
            next
        }
        { print }
    ' "${VERSION_FILE}" > "${temporary_file}"

    mv "${temporary_file}" "${VERSION_FILE}"
    trap - EXIT
done

echo "Updated native dependency revisions in ${VERSION_FILE}"
