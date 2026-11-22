//! Cast editing: open a Director cast, change its members and write it back.
//!
//! Generic Director code (no Habbo rules): the container ([`container`]), members ([`cast`]), pixel encoding
//! ([`bitmap`]) and sprite-like drawing for previews ([`render`]), exposed to JavaScript as [`api::CastDocument`].
//! The Habbo furni editor (`habbo/furni-editor`) is built on it.

pub mod api;
pub mod bitmap;
pub mod cast;
pub mod container;
pub mod render;

#[cfg(test)]
mod tests;
