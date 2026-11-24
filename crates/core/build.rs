//! A fingerprint of what makes a thread's rows from its log: this crate and the log's own. A saved
//! thread made by other code is folded again; a build that changes neither keeps them [D503].

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

fn files(dir: &Path, all: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        match e.path() {
            p if p.is_dir() => files(&p, all),
            p => all.push(p),
        }
    }
}

fn main() {
    let mut hash = DefaultHasher::new();
    for dir in ["src", "../frames/src"] {
        println!("cargo:rerun-if-changed={dir}");
        let mut all = vec![];
        files(Path::new(dir), &mut all);
        all.sort();
        for file in all {
            (&file, fs::read(&file).unwrap()).hash(&mut hash);
        }
    }
    println!("cargo:rustc-env=BRIGADIER_FOLDS={}", hash.finish() as u32);
}
