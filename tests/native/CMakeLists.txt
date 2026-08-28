cmake_minimum_required(VERSION 3.15)

project(dimina_native_lifecycle_tests C)

include("${CMAKE_CURRENT_LIST_DIR}/../../cmake/DependencyVersions.cmake")
include("${CMAKE_CURRENT_LIST_DIR}/../../cmake/DiminaLibuv.cmake")

dimina_add_libuv_lifecycle_test(dimina_libuv_lifecycle_test)
