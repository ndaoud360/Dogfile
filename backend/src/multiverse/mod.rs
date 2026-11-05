// Dogfile Multiverse: try a reorganisation of a folder in a "what if" copy first (nothing on disk changes), look at the
// result, switch changes on and off one by one, then make it real in one safe step that can be undone.
pub mod blobs;
pub mod env;
pub mod exec;
pub mod pack;
pub mod presets;
pub mod reality;
pub mod tree;
pub mod api;
#[cfg(test)]
mod tests;
