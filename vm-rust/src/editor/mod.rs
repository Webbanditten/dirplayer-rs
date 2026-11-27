//! Cast editing: open a Director cast, change its members and write it back.
//!
//! Generic Director code (no Habbo rules): the container ([`container`]), members ([`cast`]), pixel encoding
//! ([`bitmap`]), sprite-like drawing for previews ([`render`]) and reading Flash files' assets ([`swf`]), exposed to
//! JavaScript as [`api::CastDocument`] and [`api::SwfDocument`].
//! The Habbo furni editor (`habbo/furni-editor`) is built on it.

pub mod api;
pub mod bitmap;
pub mod cast;
pub mod container;
pub mod render;
pub mod swf;

#[cfg(test)]
mod tests;
