# CMake minimum version requirement
cmake_minimum_required(VERSION 3.15)  # 使用较新的 CMake 版本

# Project name
project(quickjs)

# Define the root path for NativeRender
set(NATIVERENDER_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})

# Include FetchContent for downloading dependencies
include(FetchContent)

# Download QuickJS from GitHub
FetchContent_Declare(
    quickjs
    GIT_REPOSITORY https://github.com/bellard/quickjs.git
    GIT_TAG master
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(quickjs)

# Handle the version file to prevent compilation errors
set(VERSION_FILE "${quickjs_SOURCE_DIR}/version")
if(EXISTS "${VERSION_FILE}")
    # Read the version content
    file(READ "${VERSION_FILE}" QJS_VERSION)
    string(STRIP "${QJS_VERSION}" QJS_VERSION)
    
    # Create a version.h file instead
    file(WRITE "${quickjs_SOURCE_DIR}/version.h" "#define QJS_VERSION \"${QJS_VERSION}\"\n")
    
    # Remove or rename the original version file to prevent it from being compiled
    file(RENAME "${VERSION_FILE}" "${quickjs_SOURCE_DIR}/version.txt")
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

# Link necessary libraries
target_link_libraries(dimina PUBLIC libace_napi.z.so libhilog_ndk.z.so libuv.so)

# Additional target properties for Release mode
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    set_target_properties(dimina PROPERTIES INTERPROCEDURAL_OPTIMIZATION TRUE)  # 启用 LTO
endif()

# Output configuration messages
message(STATUS "Project: ${PROJECT_NAME}")
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "Optimization flags: -O3 -march=native -flto")