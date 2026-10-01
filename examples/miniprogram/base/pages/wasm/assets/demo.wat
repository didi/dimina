;; Self-contained demo module. Offsets passed to read/write are byte offsets.
;; Regenerate the binary with: wat2wasm demo.wat -o demo.wasm
(module
  (import "env" "double" (func $double (param i32) (result i32)))
  (memory (export "memory") 1 4)

  (func (export "add") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.add)

  (func (export "read") (param i32) (result i32)
    local.get 0
    i32.load)

  (func (export "write") (param i32 i32)
    local.get 0
    local.get 1
    i32.store)

  (func (export "callHost") (param i32) (result i32)
    local.get 0
    call $double))
