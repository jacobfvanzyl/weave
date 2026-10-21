//! Images from the clipboard, and image files dragged into the terminal, for attaching to a
//! prompt as Codex's Ctrl+V does.

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

/// File extensions treated as images when a path is pasted.
const IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

static PASTES: AtomicUsize = AtomicUsize::new(0);

/// Save the clipboard's image as a PNG in the temporary directory and return its path.
pub fn save_image() -> Result<PathBuf, String> {
    let paste = PASTES.fetch_add(1, Ordering::Relaxed) + 1;
    let path = std::env::temp_dir().join(format!("weave-paste-{}-{paste}.png", std::process::id()));
    write_clipboard_png(&path)?;
    Ok(path)
}

#[cfg(target_os = "macos")]
fn write_clipboard_png(path: &Path) -> Result<(), String> {
    // AppleScript converts whatever image is on the clipboard (screenshots are often TIFF)
    // to PNG and writes it out.
    let target = path.display().to_string().replace('"', "\\\"");
    let script = [
        format!("set target to POSIX file \"{target}\""),
        "set png to (the clipboard as «class PNGf»)".to_owned(),
        "set handle to open for access target with write permission".to_owned(),
        "set eof handle to 0".to_owned(),
        "write png to handle".to_owned(),
        "close access handle".to_owned(),
    ];
    let mut command = Command::new("osascript");
    for line in &script {
        command.arg("-e").arg(line);
    }
    let output = command
        .output()
        .map_err(|error| format!("osascript: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let _ = std::fs::remove_file(path);
        Err("there's no image on the clipboard".to_owned())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn write_clipboard_png(path: &Path) -> Result<(), String> {
    // Wayland first, then X11.
    let attempts: [(&str, &[&str]); 2] = [
        ("wl-paste", &["--no-newline", "--type", "image/png"]),
        (
            "xclip",
            &["-selection", "clipboard", "-t", "image/png", "-o"],
        ),
    ];
    for (program, args) in attempts {
        if let Ok(output) = Command::new(program).args(args).output()
            && output.status.success()
            && !output.stdout.is_empty()
        {
            return std::fs::write(path, output.stdout).map_err(|error| error.to_string());
        }
    }
    Err("there's no image on the clipboard (or wl-paste/xclip isn't installed)".to_owned())
}

#[cfg(not(unix))]
fn write_clipboard_png(_path: &Path) -> Result<(), String> {
    Err("pasting images isn't supported on this platform".to_owned())
}

/// The image a paste names, when the pasted text is one image file's path, as a terminal
/// pastes a file dragged into it (possibly quoted, or with escaped spaces).
pub fn pasted_image_path(text: &str, cwd: &Path) -> Option<PathBuf> {
    let text = text.trim();
    if text.is_empty() || text.contains('\n') {
        return None;
    }
    let unquoted = text
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
        .or_else(|| {
            text.strip_prefix('"')
                .and_then(|rest| rest.strip_suffix('"'))
        })
        .map_or_else(|| text.replace("\\ ", " "), str::to_owned);
    let path = Path::new(&unquoted);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    (IMAGE_EXTENSIONS.contains(&extension.as_str()) && path.is_file()).then_some(path)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn dragged_image_paths_are_recognized() {
        let dir = tempfile::tempdir().expect("tempdir");
        let image = dir.path().join("my shot.png");
        std::fs::write(&image, b"png").expect("image");
        std::fs::write(dir.path().join("notes.txt"), b"text").expect("text");

        let escaped = image.display().to_string().replace(' ', "\\ ");
        assert_eq!(pasted_image_path(&escaped, dir.path()), Some(image.clone()));
        let quoted = format!("'{}'", image.display());
        assert_eq!(pasted_image_path(&quoted, dir.path()), Some(image));
        assert_eq!(pasted_image_path("notes.txt", dir.path()), None);
        assert_eq!(pasted_image_path("look at this", dir.path()), None);
    }
}
