# CMake minimum version requirement
cmake_minimum_required(VERSION 3.15)  # 使用较新的 CMake 版本

# Project name
project(quickjs)

# Define the root path for NativeRender
set(NATIVERENDER_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})

# Include FetchContent for downloading dependencies
include(FetchContent)

option(DIMINA_UPDATE_QUICKJS_ON_BUILD "Update QuickJS from origin/master before each native build" ON)

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
set(VERSION_H_FILE "${quickjs_SOURCE_DIR}/version.h")
set(VERSION_TXT_FILE "${quickjs_SOURCE_DIR}/version.txt")

# 只在首次配置时处理 version 文件
if(EXISTS "${VERSION_FILE}" AND NOT EXISTS "${VERSION_H_FILE}")
    # Read the version content
    file(READ "${VERSION_FILE}" QJS_VERSION)
    string(STRIP "${QJS_VERSION}" QJS_VERSION)
    
    # Create a version.h file
    file(WRITE "${VERSION_H_FILE}" "#define QJS_VERSION \"${QJS_VERSION}\"\n")
    
    # Rename the original version file to prevent it from being compiled
    file(RENAME "${VERSION_FILE}" "${VERSION_TXT_FILE}")
elseif(NOT EXISTS "${VERSION_FILE}" AND NOT EXISTS "${VERSION_H_FILE}" AND EXISTS "${VERSION_TXT_FILE}")
    # 如果 version.txt 已存在,从它创建 version.h
    file(READ "${VERSION_TXT_FILE}" QJS_VERSION)
    string(STRIP "${QJS_VERSION}" QJS_VERSION)
    file(WRITE "${VERSION_H_FILE}" "#define QJS_VERSION \"${QJS_VERSION}\"\n")
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
        WORKING_DIRECTORY ${quickjs_SOURCE_DIR}
        COMMENT "Updating QuickJS to latest origin/master"
    )
    add_dependencies(dimina update_quickjs_latest)
endif()

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
