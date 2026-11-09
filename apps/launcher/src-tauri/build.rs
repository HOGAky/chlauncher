/**
 * Tauri build script — generates the IPC glue and embeds manifests.
 * See https://tauri.app/v2/reference/build/ for what this generates.
 */
fn main() {
    tauri_build::build();
    embed_test_manifest();
}

/// `tauri_build` embeds the application manifest (Common Controls v6, DPI
/// awareness) into binaries only. On windows-gnu, test and example binaries
/// are therefore built *without* a manifest — yet the dependency tree imports
/// `TaskDialogIndirect`, which exists only in Common Controls v6 and is
/// resolved through the manifest. Such binaries fail to start with
/// `STATUS_ENTRYPOINT_NOT_FOUND` (0xC0000139) before `main` runs.
///
/// Link a minimal comctl32-v6 manifest into test/example targets so
/// `cargo test` and `cargo run --example` work locally. MSVC builds are
/// unaffected: `embed-resource` uses the MSVC toolchain there and test
/// binaries get the same fix, while shipped binaries keep the full tauri
/// manifest (version info, icon, execution level).
#[cfg(windows)]
fn embed_test_manifest() {
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    let manifest = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<assembly xmlns=\"urn:schemas-microsoft-com:asm.v1\" manifestVersion=\"1.0\">",
        "<dependency><dependentAssembly><assemblyIdentity ",
        "type=\"win32\" name=\"Microsoft.Windows.Common-Controls\" ",
        "version=\"6.0.0.0\" processorArchitecture=\"*\" ",
        "publicKeyToken=\"6595b64144ccf1df\" language=\"*\"/>",
        "</dependentAssembly></dependency></assembly>"
    );

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let manifest_path = out_dir.join("comctl32v6.manifest");
    let rc_path = out_dir.join("comctl32v6.rc");
    fs::write(&manifest_path, manifest).unwrap();
    // windres parses backslashes in quoted strings as escape sequences,
    // so the manifest path must use forward slashes.
    let manifest_rc_path = manifest_path.display().to_string().replace('\\', "/");
    fs::write(
        &rc_path,
        format!("#include <winuser.h>\n1 RT_MANIFEST \"{manifest_rc_path}\"\n"),
    )
    .unwrap();

    if let Err(err) = embed_resource::compile_for_everything(&rc_path, embed_resource::NONE)
        .manifest_required()
    {
        println!("cargo:warning=test manifest embedding failed: {err}");
    }
}

#[cfg(not(windows))]
fn embed_test_manifest() {}
