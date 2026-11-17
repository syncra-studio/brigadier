//! Embeds an Info.plist in brigadierd, so macOS privacy prompts for what its agents do read as
//! Brigadier, with the app's own reasons [D606]. The id follows the app's (`APP_ID`, scripts/package).

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
