# CMake minimum version requirement
cmake_minimum_required(VERSION 3.15)  # 使用较新的 CMake 版本

# Project name
project(quickjs)

# Define the root path for NativeRender
set(NATIVERENDER_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})

# Include FetchContent for downloading dependencies
include(FetchContent)

option(DIMINA_UPDATE_QUICKJS_ON_BUILD "Update QuickJS from origin/master before each native build" ON)
option(DIMINA_UPDATE_BROTLI_ON_BUILD "Update Brotli from origin/master before each native build" ON)

# Download QuickJS from GitHub
FetchContent_Declare(
    quickjs
    GIT_REPOSITORY https://github.com/bellard/quickjs.git
    GIT_TAG master
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(quickjs)

# Brotli decoder used by FileSystemManager.readCompressedFile({ compressionAlgorithm: "br" }).
FetchContent_Declare(
    brotli
    GIT_REPOSITORY https://github.com/google/brotli.git
    GIT_TAG master
    GIT_SHALLOW TRUE
)
FetchContent_GetProperties(brotli)
if(NOT brotli_POPULATED)
    FetchContent_Populate(brotli)
endif()

file(GLOB BROTLI_COMMON_SOURCES
    ${brotli_SOURCE_DIR}/c/common/*.c
)
file(GLOB BROTLI_DEC_SOURCES
    ${brotli_SOURCE_DIR}/c/dec/*.c
)
add_library(brotlicommon STATIC ${BROTLI_COMMON_SOURCES})
add_library(brotlidec STATIC ${BROTLI_DEC_SOURCES})
target_include_directories(brotlicommon PUBLIC ${brotli_SOURCE_DIR}/c/include)
target_include_directories(brotlidec PUBLIC ${brotli_SOURCE_DIR}/c/include)
target_link_libraries(brotlidec PUBLIC brotlicommon)

if(DIMINA_UPDATE_BROTLI_ON_BUILD)
    find_package(Git REQUIRED)
    add_custom_target(update_brotli_latest
        COMMAND ${GIT_EXECUTABLE} fetch --depth=1 origin master
        COMMAND ${GIT_EXECUTABLE} reset --hard FETCH_HEAD
        WORKING_DIRECTORY ${brotli_SOURCE_DIR}
        COMMENT "Updating Brotli to latest origin/master"
    )
    add_dependencies(brotlicommon update_brotli_latest)
endif()

# Handle the VERSION file to prevent conflicts with C++ standard <version> header
# on case-insensitive filesystems (macOS). QuickJS ships a plain-text VERSION file
# which shadows the C++17/20 <version> header when quickjs_SOURCE_DIR is in the
# include path, causing "expected unqualified-id" errors in C++ compilations.
set(VERSION_FILE "${quickjs_SOURCE_DIR}/VERSION")
set(VERSION_H_FILE "${quickjs_SOURCE_DIR}/version.h")

if(EXISTS "${VERSION_FILE}")
    file(READ "${VERSION_FILE}" QJS_VERSION)
    string(STRIP "${QJS_VERSION}" QJS_VERSION)
    file(WRITE "${VERSION_H_FILE}" "#define QJS_VERSION \"${QJS_VERSION}\"\n")
    file(REMOVE "${VERSION_FILE}")
endif()

# Set build type to Release for optimization
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Add compiler options
add_compile_options(
    -DCONFIG_BIGNUM
    -DCONFIG_VERSION="${CONFIG_VERSION}"
    -O3              # 使用较高的优化级别
    -march=armv8-a    # 针对本地CPU架构优化
    -flto            # 启用链接时优化
)

# Include directories
include_directories(
    ${NATIVERENDER_ROOT_PATH}
    ${NATIVERENDER_ROOT_PATH}/include
    ${quickjs_SOURCE_DIR}  # Include the downloaded QuickJS source directory
)

# Explicitly list source files for better control
file(GLOB sources
    ${NATIVERENDER_ROOT_PATH}/*.cpp
    ${NATIVERENDER_ROOT_PATH}/types/qjs_extension/*.c
)

# Add QuickJS source files directly
set(QUICKJS_SOURCES
    ${quickjs_SOURCE_DIR}/quickjs.c
    ${quickjs_SOURCE_DIR}/libregexp.c
    ${quickjs_SOURCE_DIR}/libunicode.c
    ${quickjs_SOURCE_DIR}/cutils.c
    ${quickjs_SOURCE_DIR}/dtoa.c
)

# Add shared library target
add_library(dimina SHARED ${sources} ${QUICKJS_SOURCES})

if(DIMINA_UPDATE_QUICKJS_ON_BUILD)
    find_package(Git REQUIRED)
    add_custom_target(update_quickjs_latest
        COMMAND ${GIT_EXECUTABLE} fetch --depth=1 origin master
        COMMAND ${GIT_EXECUTABLE} reset --hard FETCH_HEAD
        # Remove the VERSION file to prevent conflicts with the C++ standard <version> header
        # on case-insensitive filesystems (macOS). The version value is already in version.h.
        COMMAND ${CMAKE_COMMAND} -E rm -f "${quickjs_SOURCE_DIR}/VERSION"
        WORKING_DIRECTORY ${quickjs_SOURCE_DIR}
        COMMENT "Updating QuickJS to latest origin/master"
    )
    add_dependencies(dimina update_quickjs_latest)
endif()

# Link necessary libraries
target_link_libraries(dimina PUBLIC libace_napi.z.so libhilog_ndk.z.so libuv.so)
target_link_libraries(dimina PUBLIC brotlidec brotlicommon)

# Additional target properties for Release mode
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    set_target_properties(dimina PROPERTIES INTERPROCEDURAL_OPTIMIZATION TRUE)  # 启用 LTO
endif()

# Output configuration messages
message(STATUS "Project: ${PROJECT_NAME}")
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "Optimization flags: -O3 -march=native -flto")
