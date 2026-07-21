# Dependency revisions used by native SDK builds.
#
# Keep these values immutable so local and CI builds can reuse FetchContent's
# populated sources without contacting the upstream repository on every build.
# Before creating an SDK release, run:
#
#   ./scripts/update-native-dependencies.sh
#
# The release workflow verifies that these revisions match upstream master.
set(DIMINA_QUICKJS_GIT_TAG_DEFAULT "04be246001599f5995fa2f2d8c91a0f198d3f34c")
set(DIMINA_LIBUV_GIT_TAG_DEFAULT "601a1537bb5628398c2389efbc7eecd062e8aac2")
set(DIMINA_BROTLI_GIT_TAG_DEFAULT "037b70e2ad03b20480e6407ed5851e0f114b67a7")

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

dimina_resolve_dependency_git_tag(QUICKJS)
dimina_resolve_dependency_git_tag(LIBUV)
dimina_resolve_dependency_git_tag(BROTLI)
