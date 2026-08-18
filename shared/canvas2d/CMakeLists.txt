cmake_minimum_required(VERSION 3.22.1)
project(dimina_canvas2d LANGUAGES C CXX)

set(CMAKE_C_STANDARD 99)
set(CMAKE_CXX_STANDARD 17)

# --------------------------------------------------------------------------
# NanoVG (header-only style, compiled as part of this library)
# --------------------------------------------------------------------------
set(NANOVG_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/nanovg")

# --------------------------------------------------------------------------
# stb (header-only)
# --------------------------------------------------------------------------
set(STB_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/stb")

# --------------------------------------------------------------------------
# Source files
# --------------------------------------------------------------------------
set(CANVAS2D_SOURCES
    src/canvas_renderer.cpp
    src/canvas_state.cpp
    src/canvas_color.cpp
    src/canvas_text.cpp
    src/canvas_gradient.cpp
    src/canvas_image.cpp
    src/canvas_pixel_ops.cpp
    src/canvas_composite.cpp
    src/canvas_shadow.cpp
    src/egl_surface.cpp
    # NanoVG core + GLES2 backend (compiled once here via nanovg_impl.c)
    src/nanovg_impl.c
)

# --------------------------------------------------------------------------
# Platform-specific sources
# --------------------------------------------------------------------------
if(ANDROID)
    list(APPEND CANVAS2D_SOURCES
        platform/android/canvas_jni.cpp
    )
elseif(OHOS)
    list(APPEND CANVAS2D_SOURCES
        platform/harmony/canvas_napi.cpp
    )
endif()

# --------------------------------------------------------------------------
# Library target
# --------------------------------------------------------------------------
add_library(dimina_canvas2d STATIC ${CANVAS2D_SOURCES})

target_include_directories(dimina_canvas2d
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
        ${NANOVG_DIR}/src
        ${STB_DIR}
)

# --------------------------------------------------------------------------
# Platform libraries
# --------------------------------------------------------------------------
if(ANDROID)
    target_link_libraries(dimina_canvas2d
        PUBLIC
            EGL
            GLESv2
            android
            log
    )
    target_compile_definitions(dimina_canvas2d PRIVATE DIMINA_PLATFORM_ANDROID=1)
elseif(OHOS)
    target_link_libraries(dimina_canvas2d
        PUBLIC
            EGL
            GLESv3   # HarmonyOS uses GLESv3 (superset of v2)
    )
    target_compile_definitions(dimina_canvas2d PRIVATE DIMINA_PLATFORM_HARMONY=1)
elseif(APPLE)
    # iOS: ANGLE or MetalNanoVG — linked by the host project
    target_compile_definitions(dimina_canvas2d PRIVATE DIMINA_PLATFORM_IOS=1)
endif()

# NANOVG_GLES2_IMPLEMENTATION is #define'd directly in nanovg_impl.c
# (must be defined before including nanovg_gl.h)
