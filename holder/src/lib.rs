//! weave-holder keeps one terminal alive for the weave Host (ADR 0022): its PTY, its shell, and
//! the authoritative screen in libghostty-vt.

pub mod event;
mod ffi;
pub mod launch;
pub mod resources;
pub mod vt;
