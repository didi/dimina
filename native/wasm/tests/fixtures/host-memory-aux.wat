;; Linker auxiliary globals must not shrink a JS-visible exported memory.
(module
  (memory (export "memory") 1 4)
  (global (export "__data_end") i32 (i32.const 64))
  (global (export "__heap_base") i32 (i32.const 128))
  (func (export "read") (param i32) (result i32)
    local.get 0 i32.load)
  (func (export "write") (param i32 i32)
    local.get 0 local.get 1 i32.store))
