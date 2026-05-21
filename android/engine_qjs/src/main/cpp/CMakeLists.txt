# For more information about using CMake with Android Studio, read the
# documentation: https://d.android.com/studio/projects/add-native-code.html.
# For more examples on how to use CMake, see https://github.com/android/ndk-samples.

# Sets the minimum CMake version required for this project.
cmake_minimum_required(VERSION 3.22.1)

# Declares the project name. The project name can be accessed via ${ PROJECT_NAME},
# Since this is the top level CMakeLists.txt, the project name is also accessible
# with ${CMAKE_PROJECT_NAME} (both CMake variables are in-sync within the top level
# build script scope).
project("qjs")

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

# Download libuv from GitHub
FetchContent_Declare(
    libuv
    GIT_REPOSITORY https://github.com/libuv/libuv.git
    GIT_TAG master
    GIT_SHALLOW TRUE
)

# Only the static libuv target is linked into libdimina.so. Keeping libuv's
# shared target enabled produces a separately packaged libuv.so, which must also
# satisfy Android 16 KB page-size alignment checks.
set(LIBUV_BUILD_SHARED OFF CACHE BOOL "Build shared libuv" FORCE)
FetchContent_MakeAvailable(libuv)

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
        -DENABLE_ONELOGGER
        -DCONFIG_BIGNUM
        -DCONFIG_VERSION="${CONFIG_VERSION}"
        -O3              # 使用较高的优化级别
        -flto            # 启用链接时优化
)

# Include directories
include_directories(
        ${NATIVERENDER_ROOT_PATH}
        ${NATIVERENDER_ROOT_PATH}/include
        ${quickjs_SOURCE_DIR}  # Include the downloaded QuickJS source directory
        ${libuv_SOURCE_DIR}/include  # Include libuv headers
)

# Explicitly list source files for better control
file(GLOB sources
        ${NATIVERENDER_ROOT_PATH}/*.cpp
)

# Add QuickJS source files directly - explicitly list only the C files we need
set(QUICKJS_SOURCES
    ${quickjs_SOURCE_DIR}/quickjs.c
    ${quickjs_SOURCE_DIR}/libregexp.c
    ${quickjs_SOURCE_DIR}/libunicode.c
    ${quickjs_SOURCE_DIR}/cutils.c
    ${quickjs_SOURCE_DIR}/dtoa.c
)

# Creates and names a library, sets it as either STATIC
# or SHARED, and provides the relative paths to its source code.
# You can define multiple libraries, and CMake builds them for you.
# Gradle automatically packages shared libraries with your APK.
#
# In this top level CMakeLists.txt, ${CMAKE_PROJECT_NAME} is used to define
# the target library name; in the sub-module's CMakeLists.txt, ${PROJECT_NAME}
# is preferred for the same purpose.
#
# In order to load a library into your app from Java/Kotlin, you must call
# System.loadLibrary() and pass the name of the library defined here;
# for GameActivity/NativeActivity derived applications, the same library name must be
# used in the AndroidManifest.xml file.
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

# Add linker option for 16KB page size compatibility
# This helps ensure the .so is compatible with systems using 16KB page sizes,
# especially when targeting older Android API levels where this isn't automatic.
target_link_options(dimina PRIVATE "-Wl,-z,max-page-size=16384")

# Specifies libraries CMake should link to your target library. You
# can link libraries from various origins, such as libraries defined in this
# build script, prebuilt third-party libraries, or Android system libraries.
target_link_libraries(dimina
        # List libraries link to the target library
        android
        log
        m
        uv_a)  # Link libuv static library

# Additional target properties for Release mode
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    set_target_properties(dimina PROPERTIES INTERPROCEDURAL_OPTIMIZATION TRUE)  # 启用 LTO
endif()
