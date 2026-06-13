cmake_minimum_required(VERSION 3.21)

project(weave_window_stream_native LANGUAGES C CXX OBJCXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OBJCXX_STANDARD 17)
set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT APPLE)
  message(FATAL_ERROR "weave-window-stream-native is macOS-only.")
endif()

list(APPEND CMAKE_PREFIX_PATH
  "/opt/homebrew/opt/mbedtls@3"
  "/usr/local/opt/mbedtls@3"
  "/opt/homebrew/opt/mbedtls"
  "/usr/local/opt/mbedtls"
  "/opt/homebrew/opt/openssl@3"
  "/usr/local/opt/openssl@3"
)

foreach(MBEDTLS_PREFIX "/opt/homebrew/opt/mbedtls@3" "/usr/local/opt/mbedtls@3")
  if(EXISTS "${MBEDTLS_PREFIX}/lib/libmbedtls.a")
    set(MbedTLS_INCLUDE_DIR "${MBEDTLS_PREFIX}/include" CACHE PATH "" FORCE)
    set(MbedTLS_LIBRARY "${MBEDTLS_PREFIX}/lib/libmbedtls.a" CACHE FILEPATH "" FORCE)
    set(MbedCrypto_LIBRARY "${MBEDTLS_PREFIX}/lib/libmbedcrypto.a" CACHE FILEPATH "" FORCE)
    set(MbedX509_LIBRARY "${MBEDTLS_PREFIX}/lib/libmbedx509.a" CACHE FILEPATH "" FORCE)
    break()
  endif()
endforeach()

include(FetchContent)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
set(NO_TESTS ON CACHE BOOL "" FORCE)
set(NO_WEBSOCKET ON CACHE BOOL "" FORCE)
set(NO_MEDIA OFF CACHE BOOL "" FORCE)
set(USE_NICE OFF CACHE BOOL "" FORCE)
set(USE_MBEDTLS ON CACHE BOOL "" FORCE)

FetchContent_Declare(
  libdatachannel
  GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
  GIT_TAG v0.24.3
  GIT_SHALLOW TRUE
  GIT_SUBMODULES_RECURSE TRUE
)
FetchContent_MakeAvailable(libdatachannel)

add_executable(weave-window-stream-native
  Sources/main.mm
)

target_compile_options(weave-window-stream-native PRIVATE
  -fobjc-arc
)

target_link_libraries(weave-window-stream-native PRIVATE
  LibDataChannel::LibDataChannel
  "-framework AppKit"
  "-framework CoreFoundation"
  "-framework CoreMedia"
  "-framework CoreVideo"
  "-framework Foundation"
  "-framework ScreenCaptureKit"
  "-framework VideoToolbox"
)

set_target_properties(weave-window-stream-native PROPERTIES
  OUTPUT_NAME weave-window-stream-native
)
