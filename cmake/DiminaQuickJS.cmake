include_guard(GLOBAL)

include(CMakeParseArguments)

get_filename_component(DIMINA_REPOSITORY_ROOT "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(DIMINA_QUICKJS_VENDOR_DIR "${DIMINA_REPOSITORY_ROOT}/third_party/quickjs")
set(DIMINA_QUICKJS_UPSTREAM_DIR "${DIMINA_QUICKJS_VENDOR_DIR}/upstream")
set(DIMINA_QUICKJS_DEBUGGER_DIR "${DIMINA_REPOSITORY_ROOT}/third_party/quickjs-debugger")

function(dimina_configure_quickjs target)
    if(NOT TARGET ${target})
        message(FATAL_ERROR "dimina_configure_quickjs requires an existing target: ${target}")
    endif()

    set(one_value_args ENABLE_DEBUGGER)
    cmake_parse_arguments(DIMINA_QUICKJS "" "${one_value_args}" "" ${ARGN})
    if(DIMINA_QUICKJS_UNPARSED_ARGUMENTS)
        message(FATAL_ERROR
            "Unknown dimina_configure_quickjs arguments: ${DIMINA_QUICKJS_UNPARSED_ARGUMENTS}"
        )
    endif()

    set(upstream_revision_file "${DIMINA_QUICKJS_VENDOR_DIR}/UPSTREAM_COMMIT")
    set(upstream_version_file "${DIMINA_QUICKJS_UPSTREAM_DIR}/VERSION")
    set(debugger_patch "${DIMINA_QUICKJS_DEBUGGER_DIR}/patches/quickjs.patch")
    set(quickjs_build_files
        quickjs.c
        quickjs.h
        quickjs-atom.h
        quickjs-opcode.h
        list.h
        cutils.c
        cutils.h
        libregexp.c
        libregexp.h
        libregexp-opcode.h
        libunicode.c
        libunicode.h
        libunicode-table.h
        dtoa.c
        dtoa.h
    )
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${upstream_revision_file}"
        "${upstream_version_file}"
        "${debugger_patch}"
    )

    set(required_files "${upstream_revision_file}" "${upstream_version_file}")
    foreach(quickjs_build_file IN LISTS quickjs_build_files)
        list(APPEND required_files "${DIMINA_QUICKJS_UPSTREAM_DIR}/${quickjs_build_file}")
    endforeach()
    foreach(required_file IN LISTS required_files)
        if(NOT EXISTS "${required_file}")
            message(FATAL_ERROR "Vendored QuickJS file is missing: ${required_file}")
        endif()
    endforeach()

    file(READ "${upstream_revision_file}" quickjs_revision)
    string(STRIP "${quickjs_revision}" quickjs_revision)
    string(LENGTH "${quickjs_revision}" quickjs_revision_length)
    if(NOT quickjs_revision MATCHES "^[0-9a-fA-F]+$" OR
       NOT quickjs_revision_length EQUAL 40)
        message(FATAL_ERROR "third_party/quickjs/UPSTREAM_COMMIT must contain a full commit SHA")
    endif()

    file(READ "${upstream_version_file}" quickjs_version)
    string(STRIP "${quickjs_version}" quickjs_version)
    set(active_source_dir "${DIMINA_QUICKJS_UPSTREAM_DIR}")

    if(DIMINA_QUICKJS_ENABLE_DEBUGGER)
        if(NOT EXISTS "${debugger_patch}")
            message(FATAL_ERROR "QuickJS debugger patch is missing: ${debugger_patch}")
        endif()

        find_package(Git REQUIRED)
        file(SHA256 "${debugger_patch}" debugger_patch_sha256)
        # Bump the preparation version when the build-local source layout changes.
        set(debugger_signature "v1:${quickjs_revision}:${debugger_patch_sha256}")
        set(active_source_dir "${CMAKE_CURRENT_BINARY_DIR}/quickjs_debugger_source")
        set(debugger_stamp "${active_source_dir}/.dimina-debugger-source")
        set(refresh_debugger_source TRUE)

        if(EXISTS "${debugger_stamp}")
            file(READ "${debugger_stamp}" existing_debugger_signature)
            string(STRIP "${existing_debugger_signature}" existing_debugger_signature)
            if("${existing_debugger_signature}" STREQUAL "${debugger_signature}")
                set(refresh_debugger_source FALSE)
            endif()
        endif()

        if(refresh_debugger_source)
            set(staging_source_dir "${active_source_dir}.tmp")
            file(REMOVE_RECURSE "${staging_source_dir}")
            file(MAKE_DIRECTORY "${staging_source_dir}")
            foreach(quickjs_build_file IN LISTS quickjs_build_files)
                configure_file(
                    "${DIMINA_QUICKJS_UPSTREAM_DIR}/${quickjs_build_file}"
                    "${staging_source_dir}/${quickjs_build_file}"
                    COPYONLY
                )
            endforeach()

            execute_process(
                COMMAND ${CMAKE_COMMAND} -E env
                    "GIT_CEILING_DIRECTORIES=${DIMINA_REPOSITORY_ROOT}"
                    ${GIT_EXECUTABLE} apply --check "${debugger_patch}"
                WORKING_DIRECTORY "${staging_source_dir}"
                RESULT_VARIABLE patch_check_result
                OUTPUT_VARIABLE patch_output
                ERROR_VARIABLE patch_error
            )
            if(NOT patch_check_result EQUAL 0)
                file(REMOVE_RECURSE "${staging_source_dir}")
                message(FATAL_ERROR
                    "Vendored QuickJS does not match the debugger patch:\n"
                    "${patch_output}${patch_error}"
                )
            endif()

            execute_process(
                COMMAND ${CMAKE_COMMAND} -E env
                    "GIT_CEILING_DIRECTORIES=${DIMINA_REPOSITORY_ROOT}"
                    ${GIT_EXECUTABLE} apply "${debugger_patch}"
                WORKING_DIRECTORY "${staging_source_dir}"
                RESULT_VARIABLE patch_result
                OUTPUT_VARIABLE patch_output
                ERROR_VARIABLE patch_error
            )
            if(NOT patch_result EQUAL 0)
                file(REMOVE_RECURSE "${staging_source_dir}")
                message(FATAL_ERROR
                    "Failed to apply the QuickJS debugger patch:\n"
                    "${patch_output}${patch_error}"
                )
            endif()

            file(WRITE "${staging_source_dir}/.dimina-debugger-source" "${debugger_signature}\n")
            file(REMOVE_RECURSE "${active_source_dir}")
            file(RENAME "${staging_source_dir}" "${active_source_dir}")
        endif()
    endif()

    set(public_include_dir "${CMAKE_CURRENT_BINARY_DIR}/quickjs_public_include")
    file(MAKE_DIRECTORY "${public_include_dir}")
    foreach(public_header quickjs.h cutils.h libregexp.h libunicode.h)
        configure_file(
            "${active_source_dir}/${public_header}"
            "${public_include_dir}/${public_header}"
            COPYONLY
        )
    endforeach()

    target_sources(${target} PRIVATE
        "${active_source_dir}/quickjs.c"
        "${active_source_dir}/libregexp.c"
        "${active_source_dir}/libunicode.c"
        "${active_source_dir}/cutils.c"
        "${active_source_dir}/dtoa.c"
    )
    target_include_directories(${target} PRIVATE "${public_include_dir}")
    target_compile_definitions(${target} PRIVATE
        CONFIG_BIGNUM
        CONFIG_VERSION="${quickjs_version}"
    )

    if(DIMINA_QUICKJS_ENABLE_DEBUGGER)
        target_sources(${target} PRIVATE
            "${DIMINA_QUICKJS_DEBUGGER_DIR}/src/quickjs-debugger.c"
            "${DIMINA_QUICKJS_DEBUGGER_DIR}/src/transport-posix.c"
        )
        target_include_directories(${target} PRIVATE
            "${DIMINA_QUICKJS_DEBUGGER_DIR}/include"
        )
        target_compile_definitions(${target} PRIVATE DIMINA_ENABLE_QUICKJS_DEBUGGER=1)
    endif()

    message(STATUS "QuickJS source: ${active_source_dir}")
    message(STATUS "QuickJS version: ${quickjs_version} (${quickjs_revision})")
    message(STATUS "QuickJS debugger: ${DIMINA_QUICKJS_ENABLE_DEBUGGER}")
endfunction()
