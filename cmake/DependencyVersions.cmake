# Revisions for native dependencies that are fetched during SDK builds.
#
# Keep these values immutable so local and CI builds can reuse FetchContent's
# populated sources without contacting the upstream repository on every build.
# QuickJS is vendored separately under third_party/quickjs so Android and
# Harmony builds do not depend on a source checkout or network access.
# Before creating an SDK release, run:
#
#   ./scripts/update-native-dependencies.sh
#
# The release workflow verifies that these revisions match upstream master.
set(DIMINA_LIBUV_GIT_TAG_DEFAULT "601a1537bb5628398c2389efbc7eecd062e8aac2")
set(DIMINA_BROTLI_GIT_TAG_DEFAULT "2ff28fb62deeb8c49720acf2c16ecc8f6f7408f1")

macro(dimina_resolve_dependency_git_tag dependency_name)
    set(_dimina_git_tag_variable "DIMINA_${dependency_name}_GIT_TAG")
    set(_dimina_default_git_tag_variable "DIMINA_${dependency_name}_GIT_TAG_DEFAULT")

    if(NOT DEFINED ${_dimina_git_tag_variable})
        set(${_dimina_git_tag_variable} "${${_dimina_default_git_tag_variable}}")
    endif()

    string(LENGTH "${${_dimina_git_tag_variable}}" _dimina_git_tag_length)
    if(NOT "${${_dimina_git_tag_variable}}" MATCHES "^[0-9a-fA-F]+$" OR
       NOT _dimina_git_tag_length EQUAL 40)
        message(FATAL_ERROR "${_dimina_git_tag_variable} must be a full 40-character commit SHA")
    endif()
endmacro()

dimina_resolve_dependency_git_tag(LIBUV)
dimina_resolve_dependency_git_tag(BROTLI)
