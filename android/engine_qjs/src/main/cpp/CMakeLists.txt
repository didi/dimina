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

include("${CMAKE_CURRENT_LIST_DIR}/../../../../../cmake/DependencyVersions.cmake")
include("${CMAKE_CURRENT_LIST_DIR}/../../../../../cmake/DiminaLibuv.cmake")
include("${CMAKE_CURRENT_LIST_DIR}/../../../../../cmake/DiminaQuickJS.cmake")

# Android does not expose the debugger API yet. Keeping the option explicit lets
# the shared QuickJS preparation be enabled when the runtime wiring lands.
option(DIMINA_ENABLE_QUICKJS_DEBUGGER "Build the QuickJS breakpoint debugger" OFF)

# Set build type to Release for optimization
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Add compiler options
add_compile_options(
        -DENABLE_ONELOGGER
        -O3              # 使用较高的优化级别
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
add_library(dimina SHARED ${sources})

dimina_configure_quickjs(dimina
    ENABLE_DEBUGGER "${DIMINA_ENABLE_QUICKJS_DEBUGGER}"
)
dimina_configure_libuv(dimina)

# Add linker option for 16KB page size compatibility
# This helps ensure the .so is compatible with systems using 16KB page sizes,
# especially when targeting older Android API levels where this isn't automatic.
target_link_options(dimina PRIVATE "-Wl,-z,max-page-size=16384")

# Specifies libraries CMake should link to your target library. You
# can link libraries from various origins, such as libraries defined in this
# build script, prebuilt third-party libraries, or Android system libraries.
target_link_libraries(dimina
        PRIVATE
        # List libraries link to the target library
        android
        log
        m)

# Additional target properties for Release mode
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    set_target_properties(dimina PROPERTIES INTERPROCEDURAL_OPTIMIZATION TRUE)  # 启用 LTO
endif()
