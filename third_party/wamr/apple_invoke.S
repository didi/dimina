#define BH_PLATFORM_DARWIN 1
#if defined(__aarch64__) || defined(__arm64__)
#include "upstream/core/iwasm/common/arch/invokeNative_aarch64.s"
#elif defined(__x86_64__)
#include "upstream/core/iwasm/common/arch/invokeNative_em64.s"
#else
#error Unsupported Apple architecture
#endif
