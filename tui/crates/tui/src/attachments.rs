//! `@path` mentions in a prompt, attached as the richest content block the agent accepts.
//!
//! Text is always sent as typed. Each mentioned file is added after it: images and audio as
//! `image`/`audio` blocks when `promptCapabilities` allows, small text files embedded as a
//! `resource` with `embeddedContext`, and anything else as a `resource_link`, which every
//! agent must accept.

use std::path::Path;
use std::path::PathBuf;

use base64::Engine;
use weave_acp_core::schema::AudioContent;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::EmbeddedResource;
use weave_acp_core::schema::EmbeddedResourceResource;
use weave_acp_core::schema::ImageContent;
use weave_acp_core::schema::PromptCapabilities;
use weave_acp_core::schema::ResourceLink;
use weave_acp_core::schema::TextContent;
use weave_acp_core::schema::TextResourceContents;

/// Files embedded or sent inline only up to this size; larger ones are linked.
const INLINE_LIMIT: u64 = 5 * 1024 * 1024;
/// Text files embedded as resources only up to this size.
const EMBED_TEXT_LIMIT: u64 = 256 * 1024;

/// How one mentioned file was attached, for the transcript.
#[derive(Debug, PartialEq, Eq)]
pub struct Attachment {
    pub name: String,
    pub kind: &'static str,
}

/// The prompt's content blocks: the text, then one block per mentioned file that exists.
/// `images` are files pasted into the prompt, each with the label it shows as there.
pub fn prompt_blocks(
    text: &str,
    cwd: &Path,
    capabilities: &PromptCapabilities,
    images: &[(String, PathBuf)],
) -> (Vec<ContentBlock>, Vec<Attachment>) {
    let mut blocks = vec![ContentBlock::Text(TextContent::new(text))];
    let mut attachments = Vec::new();
    let mut seen = Vec::new();
    for mention in mentions(text) {
        let path = if Path::new(mention).is_absolute() {
            PathBuf::from(mention)
        } else {
            cwd.join(mention)
        };
        let Ok(path) = path.canonicalize() else {
            continue;
        };
        if !path.is_file() || seen.contains(&path) {
            continue;
        }
        if let Some((block, kind)) = attach(&path, capabilities) {
            attachments.push(Attachment {
                name: mention.to_owned(),
                kind,
            });
            blocks.push(block);
            seen.push(path);
        }
    }
    for (label, path) in images {
        if seen.contains(path) {
            continue;
        }
        if let Some((block, kind)) = attach(path, capabilities) {
            attachments.push(Attachment {
                name: label.clone(),
                kind,
            });
            blocks.push(block);
            seen.push(path.clone());
        }
    }
    (blocks, attachments)
}

/// `@token`s at word starts, without trailing punctuation.
fn mentions(text: &str) -> Vec<&str> {
    text.split_whitespace()
        .filter_map(|word| word.strip_prefix('@'))
        .map(|mention| mention.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', '"', '\'']))
        .filter(|mention| !mention.is_empty())
        .collect()
}

fn attach(path: &Path, capabilities: &PromptCapabilities) -> Option<(ContentBlock, &'static str)> {
    let uri = url::Url::from_file_path(path).ok()?.to_string();
    let name = path.file_name()?.to_string_lossy().into_owned();
    let size = std::fs::metadata(path).ok()?.len();
    let mime = mime_type(path);
    let encode = || {
        std::fs::read(path)
            .ok()
            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
    };

    if size <= INLINE_LIMIT {
        match mime {
            Some(mime) if mime.starts_with("image/") && capabilities.image => {
                let block = ImageContent::new(encode()?, mime).uri(uri);
                return Some((ContentBlock::Image(block), "image"));
            }
            Some(mime) if mime.starts_with("audio/") && capabilities.audio => {
                let block = AudioContent::new(encode()?, mime);
                return Some((ContentBlock::Audio(block), "audio"));
            }
            _ => {}
        }
    }
    if size <= EMBED_TEXT_LIMIT
        && capabilities.embedded_context
        && let Ok(text) = std::fs::read_to_string(path)
    {
        let contents = TextResourceContents::new(text, uri).mime_type(mime.map(str::to_owned));
        let block = EmbeddedResource::new(EmbeddedResourceResource::TextResourceContents(contents));
        return Some((ContentBlock::Resource(block), "embedded"));
    }
    let link = ResourceLink::new(name, uri)
        .size(i64::try_from(size).ok())
        .mime_type(mime.map(str::to_owned));
    Some((ContentBlock::ResourceLink(link), "link"))
}

fn mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "md" => "text/markdown",
        "rs" => "text/x-rust",
        "json" => "application/json",
        "toml" => "application/toml",
        "txt" | "log" => "text/plain",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn kinds(blocks: &[ContentBlock]) -> Vec<&'static str> {
        blocks
            .iter()
            .map(|block| match block {
                ContentBlock::Text(_) => "text",
                ContentBlock::Image(_) => "image",
                ContentBlock::Audio(_) => "audio",
                ContentBlock::Resource(_) => "resource",
                ContentBlock::ResourceLink(_) => "resource_link",
                _ => "other",
            })
            .collect()
    }

    fn workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("notes.md"), "# Notes").expect("notes");
        std::fs::write(dir.path().join("shot.png"), [0x89, b'P', b'N', b'G']).expect("png");
        std::fs::write(dir.path().join("clip.wav"), b"RIFF").expect("wav");
        std::fs::write(dir.path().join("data.bin"), [0, 159, 146, 150]).expect("bin");
        dir
    }

    #[test]
    fn mentions_use_the_richest_block_the_agent_accepts() {
        let dir = workspace();
        let all = PromptCapabilities::new()
            .image(true)
            .audio(true)
            .embedded_context(true);
        let (blocks, attachments) = prompt_blocks(
            "see @notes.md, @shot.png and @clip.wav plus @data.bin",
            dir.path(),
            &all,
            &[],
        );
        assert_eq!(
            kinds(&blocks),
            ["text", "resource", "image", "audio", "resource_link"]
        );
        assert_eq!(
            attachments
                .iter()
                .map(|attachment| attachment.kind)
                .collect::<Vec<_>>(),
            ["embedded", "image", "audio", "link"]
        );
    }

    #[test]
    fn without_capabilities_every_file_is_a_link() {
        let dir = workspace();
        let (blocks, _) = prompt_blocks(
            "@notes.md @shot.png @clip.wav",
            dir.path(),
            &PromptCapabilities::new(),
            &[],
        );
        assert_eq!(
            kinds(&blocks),
            ["text", "resource_link", "resource_link", "resource_link"]
        );
    }

    #[test]
    fn missing_files_and_repeats_are_left_as_text() {
        let dir = workspace();
        let (blocks, attachments) = prompt_blocks(
            "@missing.txt @notes.md @notes.md email@example.com",
            dir.path(),
            &PromptCapabilities::new(),
            &[],
        );
        assert_eq!(kinds(&blocks), ["text", "resource_link"]);
        assert_eq!(attachments.len(), 1);
    }
}
