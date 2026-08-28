#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
VERSION_FILE="${REPOSITORY_ROOT}/cmake/DependencyVersions.cmake"
QUICKJS_REPOSITORY="https://github.com/bellard/quickjs.git"
QUICKJS_VENDOR_DIR="${REPOSITORY_ROOT}/third_party/quickjs"
QUICKJS_SOURCE_DIR="${QUICKJS_VENDOR_DIR}/upstream"
QUICKJS_REVISION_FILE="${QUICKJS_VENDOR_DIR}/UPSTREAM_COMMIT"
QUICKJS_DEBUGGER_PATCH="${REPOSITORY_ROOT}/third_party/quickjs-debugger/patches/quickjs.patch"

dependency_names=("libuv" "Brotli")
dependency_variables=("DIMINA_LIBUV_GIT_TAG_DEFAULT" "DIMINA_BROTLI_GIT_TAG_DEFAULT")
dependency_repositories=("https://github.com/libuv/libuv.git" "https://github.com/google/brotli.git")

usage() {
    echo "Usage: $0 [--check|--update]"
    echo "  --check   Validate the vendored QuickJS snapshot and fail if a native dependency is not upstream master."
    echo "  --update  Replace QuickJS and update fetched dependency revisions to upstream master (default)."
}

resolve_master_sha() {
    local dependency_name="$1"
    local dependency_repository="$2"
    local resolved_sha

    resolved_sha=$(git ls-remote "${dependency_repository}" refs/heads/master | awk 'NR == 1 { print $1 }')
    if [[ ! "${resolved_sha}" =~ ^[0-9a-f]{40}$ ]]; then
        echo "Unable to resolve ${dependency_name} upstream master from ${dependency_repository}" >&2
        exit 1
    fi
    printf '%s\n' "${resolved_sha}"
}

validate_quickjs_snapshot() {
    local source_dir="$1"
    local required_file

    for required_file in VERSION LICENSE quickjs.c quickjs.h cutils.c libregexp.c libunicode.c dtoa.c; do
        if [[ ! -f "${source_dir}/${required_file}" ]]; then
            echo "Vendored QuickJS file is missing: ${source_dir}/${required_file}" >&2
            return 1
        fi
    done

    if ! GIT_CEILING_DIRECTORIES="${REPOSITORY_ROOT}" \
        git -C "${source_dir}" apply --check "${QUICKJS_DEBUGGER_PATCH}"; then
        echo "The QuickJS debugger patch does not apply to ${source_dir}." >&2
        return 1
    fi
}

prepare_quickjs_snapshot() {
    local output_root="$1"
    local checkout_dir="${output_root}/repository"
    local archive_file="${output_root}/quickjs.tar"
    local source_dir="${output_root}/upstream"

    git clone --quiet --depth 1 "${QUICKJS_REPOSITORY}" "${checkout_dir}"
    prepared_quickjs_sha=$(git -C "${checkout_dir}" rev-parse HEAD)
    if [[ ! "${prepared_quickjs_sha}" =~ ^[0-9a-f]{40}$ ]]; then
        echo "Unable to resolve the cloned QuickJS commit" >&2
        return 1
    fi

    mkdir -p "${source_dir}"
    git -C "${checkout_dir}" archive --format=tar --output="${archive_file}" HEAD
    tar -xf "${archive_file}" -C "${source_dir}"
    validate_quickjs_snapshot "${source_dir}"
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

if [[ ! -f "${QUICKJS_REVISION_FILE}" ]]; then
    echo "QuickJS revision metadata is missing: ${QUICKJS_REVISION_FILE}" >&2
    exit 1
fi

current_quickjs_sha=$(tr -d '[:space:]' < "${QUICKJS_REVISION_FILE}")
if [[ ! "${current_quickjs_sha}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Unable to read the vendored QuickJS commit from ${QUICKJS_REVISION_FILE}" >&2
    exit 1
fi
validate_quickjs_snapshot "${QUICKJS_SOURCE_DIR}"

latest_quickjs_sha=$(resolve_master_sha "QuickJS" "${QUICKJS_REPOSITORY}")
quickjs_outdated=false
if [[ "${current_quickjs_sha}" == "${latest_quickjs_sha}" ]]; then
    echo "QuickJS is up to date: ${current_quickjs_sha}"
else
    quickjs_outdated=true
    dependencies_outdated=true
    echo "QuickJS is outdated: ${current_quickjs_sha} -> ${latest_quickjs_sha}"
fi

for dependency_index in "${!dependency_names[@]}"; do
    dependency_name="${dependency_names[dependency_index]}"
    dependency_variable="${dependency_variables[dependency_index]}"
    dependency_repository="${dependency_repositories[dependency_index]}"

    current_sha=$(sed -n "s/^set(${dependency_variable} \"\\([0-9a-f]\\{40\\}\\)\")$/\\1/p" "${VERSION_FILE}")
    if [[ ! "${current_sha}" =~ ^[0-9a-f]{40}$ ]]; then
        echo "Unable to read the pinned ${dependency_name} commit from ${VERSION_FILE}" >&2
        exit 1
    fi

    latest_sha=$(resolve_master_sha "${dependency_name}" "${dependency_repository}")

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
    echo "Run ./scripts/update-native-dependencies.sh, test both native SDKs, and commit the source and revision updates before releasing." >&2
    exit 1
fi

quickjs_update_root=""
if [[ "${quickjs_outdated}" == true ]]; then
    quickjs_update_root=$(mktemp -d "${TMPDIR:-/tmp}/dimina-quickjs-update.XXXXXX")
    trap 'rm -rf "${quickjs_update_root}"' EXIT
    prepared_quickjs_sha=""
    prepare_quickjs_snapshot "${quickjs_update_root}"

    if [[ "${prepared_quickjs_sha}" != "${latest_quickjs_sha}" ]]; then
        echo "QuickJS master changed while preparing the update; run the script again." >&2
        exit 1
    fi

    quickjs_staging_dir="${QUICKJS_VENDOR_DIR}/upstream.new"
    quickjs_backup_dir="${QUICKJS_VENDOR_DIR}/upstream.backup"
    if [[ -e "${quickjs_staging_dir}" || -e "${quickjs_backup_dir}" ]]; then
        echo "Refusing to overwrite an existing QuickJS update directory under ${QUICKJS_VENDOR_DIR}" >&2
        exit 1
    fi

    quickjs_revision_temp=$(mktemp "${QUICKJS_REVISION_FILE}.XXXXXX")
    printf '%s\n' "${prepared_quickjs_sha}" > "${quickjs_revision_temp}"
    mv "${quickjs_update_root}/upstream" "${quickjs_staging_dir}"
    mv "${QUICKJS_SOURCE_DIR}" "${quickjs_backup_dir}"
    if ! mv "${quickjs_staging_dir}" "${QUICKJS_SOURCE_DIR}"; then
        mv "${quickjs_backup_dir}" "${QUICKJS_SOURCE_DIR}"
        exit 1
    fi
    mv "${quickjs_revision_temp}" "${QUICKJS_REVISION_FILE}"
    rm -rf "${quickjs_backup_dir}"
    rm -rf "${quickjs_update_root}"
    trap - EXIT

    echo "Updated vendored QuickJS snapshot to ${prepared_quickjs_sha}"
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

echo "Updated fetched native dependency revisions in ${VERSION_FILE}"
