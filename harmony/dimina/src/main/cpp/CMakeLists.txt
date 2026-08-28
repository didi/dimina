# CMake minimum version requirement
cmake_minimum_required(VERSION 3.15)  # 使用较新的 CMake 版本

# Project name
project(quickjs)

# Define the root path for NativeRender
set(NATIVERENDER_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})

# Include FetchContent for downloading dependencies
include(FetchContent)

include("${CMAKE_CURRENT_LIST_DIR}/../../../../../cmake/DependencyVersions.cmake")
include("${CMAKE_CURRENT_LIST_DIR}/../../../../../cmake/DiminaLibuv.cmake")
include("${CMAKE_CURRENT_LIST_DIR}/../../../../../cmake/DiminaQuickJS.cmake")

string(TOLOWER "${CMAKE_BUILD_TYPE}" DIMINA_BUILD_TYPE_LOWER)
set(DIMINA_QUICKJS_DEBUGGER_DEFAULT OFF)
if(DIMINA_BUILD_TYPE_LOWER STREQUAL "debug")
    set(DIMINA_QUICKJS_DEBUGGER_DEFAULT ON)
endif()
option(DIMINA_ENABLE_QUICKJS_DEBUGGER "Build the QuickJS breakpoint debugger" ${DIMINA_QUICKJS_DEBUGGER_DEFAULT})

# Brotli decoder used by FileSystemManager.readCompressedFile({ compressionAlgorithm: "br" }).
FetchContent_Declare(
    brotli
    GIT_REPOSITORY https://github.com/google/brotli.git
    GIT_TAG ${DIMINA_BROTLI_GIT_TAG}
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

# Set build type to Release for optimization
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Add compiler options
add_compile_options(
    -O3              # 使用较高的优化级别
    -march=armv8-a    # 针对本地CPU架构优化
    -flto            # 启用链接时优化
)

# Include directories
include_directories(
    ${NATIVERENDER_ROOT_PATH}
    ${NATIVERENDER_ROOT_PATH}/include
)

# Explicitly list source files for better control
file(GLOB sources
    ${NATIVERENDER_ROOT_PATH}/*.cpp
    ${NATIVERENDER_ROOT_PATH}/types/qjs_extension/*.c
)

# Add shared library target
add_library(dimina SHARED ${sources})

dimina_configure_quickjs(dimina
    ENABLE_DEBUGGER "${DIMINA_ENABLE_QUICKJS_DEBUGGER}"
)
dimina_configure_libuv(dimina)

# Link necessary libraries
target_link_libraries(dimina PUBLIC libace_napi.z.so libhilog_ndk.z.so)
target_link_libraries(dimina PUBLIC brotlidec brotlicommon)

# Additional target properties for Release mode
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    set_target_properties(dimina PROPERTIES INTERPROCEDURAL_OPTIMIZATION TRUE)  # 启用 LTO
endif()

# Output configuration messages
message(STATUS "Project: ${PROJECT_NAME}")
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "Optimization flags: -O3 -march=native -flto")
