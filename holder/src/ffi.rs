//! libghostty-vt's C API, as bindgen generated it from the pinned headers (see `build.rs`).

#![allow(
    dead_code,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unsafe_op_in_unsafe_fn,
    clippy::all
)]

include!("ffi/bindings.rs");
