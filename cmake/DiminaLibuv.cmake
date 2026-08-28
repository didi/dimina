include_guard(GLOBAL)

include(FetchContent)

get_filename_component(DIMINA_REPOSITORY_ROOT "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)

function(_dimina_ensure_libuv)
    if(TARGET dimina::libuv)
        return()
    endif()

    add_library(dimina_libuv INTERFACE)
    add_library(dimina::libuv ALIAS dimina_libuv)

    if(ANDROID OR CMAKE_SYSTEM_NAME STREQUAL "Android")
        if(NOT DEFINED DIMINA_LIBUV_GIT_TAG)
            message(FATAL_ERROR
                "DIMINA_LIBUV_GIT_TAG is required before including DiminaLibuv.cmake"
            )
        endif()

        # Android has no system libuv. Build the pinned upstream revision as a
        # static library so the SDK ships only libdimina.so.
        set(LIBUV_BUILD_SHARED OFF CACHE BOOL "Build shared libuv" FORCE)
        set(LIBUV_BUILD_TESTS OFF CACHE BOOL "Build libuv tests" FORCE)
        set(LIBUV_BUILD_BENCH OFF CACHE BOOL "Build libuv benchmarks" FORCE)
        FetchContent_Declare(
            libuv
            GIT_REPOSITORY https://github.com/libuv/libuv.git
            GIT_TAG ${DIMINA_LIBUV_GIT_TAG}
        )
        FetchContent_MakeAvailable(libuv)

        if(NOT TARGET uv_a)
            message(FATAL_ERROR "Pinned Android libuv did not define the uv_a target")
        endif()

        # Android NDK r28 does not expose LLONG_MAX from <limits.h> in libuv's
        # default GNU90 mode, while current libuv uses it in src/unix/linux.c.
        set_property(TARGET uv_a PROPERTY C_STANDARD 99)

        target_include_directories(dimina_libuv SYSTEM INTERFACE
            "${libuv_SOURCE_DIR}/include"
        )
        target_link_libraries(dimina_libuv INTERFACE uv_a)
        set(libuv_provider "pinned static uv_a (${DIMINA_LIBUV_GIT_TAG})")
    elseif(CMAKE_SYSTEM_NAME STREQUAL "OHOS")
        # OpenHarmony provides libuv in its native sysroot. Reusing it avoids a
        # second event-loop implementation and keeps the HAR free of libuv.so.
        target_link_libraries(dimina_libuv INTERFACE libuv.so)
        set(libuv_provider "OpenHarmony system libuv.so")
    else()
        message(FATAL_ERROR
            "Dimina libuv is not configured for CMAKE_SYSTEM_NAME=${CMAKE_SYSTEM_NAME}"
        )
    endif()

    message(STATUS "Dimina libuv provider: ${libuv_provider}")
endfunction()

function(dimina_configure_libuv target)
    if(NOT TARGET ${target})
        message(FATAL_ERROR "dimina_configure_libuv requires an existing target: ${target}")
    endif()

    _dimina_ensure_libuv()
    target_link_libraries(${target} PRIVATE dimina::libuv)
endfunction()

function(dimina_add_libuv_lifecycle_test target)
    if("${target}" STREQUAL "")
        message(FATAL_ERROR "dimina_add_libuv_lifecycle_test requires a target name")
    endif()
    if(TARGET ${target})
        message(FATAL_ERROR "dimina_add_libuv_lifecycle_test target already exists: ${target}")
    endif()

    add_executable(${target}
        "${DIMINA_REPOSITORY_ROOT}/tests/native/libuv_lifecycle_test.c"
    )
    set_target_properties(${target} PROPERTIES
        C_STANDARD 99
        C_STANDARD_REQUIRED ON
        C_EXTENSIONS OFF
    )
    dimina_configure_libuv(${target})
endfunction()
