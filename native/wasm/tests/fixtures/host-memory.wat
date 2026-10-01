;; Host growth must work without memory.grow or memory.size in the Wasm code.
(module
  (memory (export "memory") 1 4)
  (func (export "read") (param i32) (result i32)
    local.get 0 i32.load)
  (func (export "write") (param i32 i32)
    local.get 0 local.get 1 i32.store))
