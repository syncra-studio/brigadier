//! Embeds an Info.plist in brigadierd: its signing id, which follows the app's (`APP_ID`,
//! scripts/package), and the reasons a privacy prompt gives. The prompts' name and the id their
//! answers are kept by are the launcher's instead, whose bundle has these reasons too (install.rs).

fn main() {
    println!("cargo:rerun-if-env-changed=APP_ID");
    println!("cargo:rerun-if-changed=Info.plist");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let id = std::env::var("APP_ID").unwrap_or_else(|_| "sh.brigadier.app".into());
    let plist = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("Info.plist");
    let text = include_str!("Info.plist").replace("APP_ID", &id);
    std::fs::write(&plist, text).unwrap();
    println!(
        "cargo:rustc-link-arg-bin=brigadierd=-Wl,-sectcreate,__TEXT,__info_plist,{}",
        plist.display()
    );
}
