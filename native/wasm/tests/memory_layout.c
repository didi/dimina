#include "wasm_export.h"
#include "wasm.h"
#include <stdio.h>
#include <stdlib.h>

static int check_memory(const char *path, bool exported)
{
    FILE *file = fopen(path, "rb");
    if (!file) return 1;
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    rewind(file);
    uint8_t *bytes = malloc((size_t)size);
    if (!bytes || fread(bytes, 1, (size_t)size, file) != (size_t)size) {
        fclose(file); free(bytes); return 1;
    }
    fclose(file);
    char error[256];
    WASMModule *module = (WASMModule *)wasm_runtime_load(bytes, (uint32_t)size, error, sizeof(error));
    if (!module) {
        fprintf(stderr, "%s: %s\n", path, error);
        free(bytes); return 1;
    }
    int failed = 0;
    if (module->memory_count != 1 || module->possible_memory_grow != exported) {
        fprintf(stderr, "%s: host growth capability must match the exported memory\n", path);
        failed = 1;
    } else {
#if WASM_ENABLE_FAST_JIT != 0 || WASM_ENABLE_JIT != 0 || WASM_ENABLE_WAMR_COMPILER != 0
        for (uint32_t i = 0; i < module->function_count; i++) {
            if (module->functions[i]->has_op_memory_grow) {
                fprintf(stderr, "%s: fixture must not contain a memory.grow opcode\n", path);
                failed = 1;
            }
        }
#endif
        WASMMemory *memory = module->memories;
        uint32_t page_size = exported ? 65536 :
#if WASM_ENABLE_SHRUNK_MEMORY != 0
            128;
#else
            65536;
#endif
        uint32_t maximum = exported ? 4 : 1;
        if (memory->num_bytes_per_page != page_size || memory->init_page_count != 1 || memory->max_page_count != maximum) {
            fprintf(stderr, "%s: expected page size/init/max %u/1/%u; got %u/%u/%u\n", path,
                    page_size, maximum, memory->num_bytes_per_page, memory->init_page_count, memory->max_page_count);
            failed = 1;
        }
    }
    wasm_runtime_unload((wasm_module_t)module);
    free(bytes);
    return failed;
}

int main(int argc, char **argv)
{
    if (argc != 4 || !wasm_runtime_init()) return 1;
    int failed = check_memory(argv[1], true) | check_memory(argv[2], true) | check_memory(argv[3], false);
    wasm_runtime_destroy();
    return failed;
}
