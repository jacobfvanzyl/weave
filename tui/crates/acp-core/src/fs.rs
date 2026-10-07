//! `fs/read_text_file` and `fs/write_text_file`.
//!
//! The terminal client has no editor buffers, so the file on disk is the current content.

use std::io;
use std::path::Path;

use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::ReadTextFileRequest;
use agent_client_protocol::schema::v1::ReadTextFileResponse;
use agent_client_protocol::schema::v1::WriteTextFileRequest;
use agent_client_protocol::schema::v1::WriteTextFileResponse;

pub(crate) async fn read_text_file(
    request: ReadTextFileRequest,
) -> Result<ReadTextFileResponse, Error> {
    require_absolute(&request.path)?;
    let text = tokio::fs::read_to_string(&request.path)
        .await
        .map_err(|error| io_error(&request.path, &error))?;
    Ok(ReadTextFileResponse::new(select_lines(
        &text,
        request.line,
        request.limit,
    )))
}

pub(crate) async fn write_text_file(
    request: WriteTextFileRequest,
) -> Result<WriteTextFileResponse, Error> {
    require_absolute(&request.path)?;
    // The protocol requires creating a missing file; agents also expect missing parent
    // directories to be created, as their own write tools do.
    if let Some(parent) = request.path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| io_error(parent, &error))?;
    }
    tokio::fs::write(&request.path, request.content)
        .await
        .map_err(|error| io_error(&request.path, &error))?;
    Ok(WriteTextFileResponse::new())
}

/// Lines `line..line + limit` (1-based), keeping their line endings.
fn select_lines(text: &str, line: Option<u32>, limit: Option<u32>) -> String {
    if line.is_none() && limit.is_none() {
        return text.to_owned();
    }
    let skip = line.map_or(0, |line| line.saturating_sub(1) as usize);
    let take = limit.map_or(usize::MAX, |limit| limit as usize);
    text.split_inclusive('\n').skip(skip).take(take).collect()
}

fn require_absolute(path: &Path) -> Result<(), Error> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(Error::invalid_params().data(format!("path must be absolute: {}", path.display())))
    }
}

fn io_error(path: &Path, error: &io::Error) -> Error {
    match error.kind() {
        io::ErrorKind::NotFound => Error::resource_not_found(Some(path.display().to_string())),
        _ => Error::internal_error().data(format!("{}: {error}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_one_based_line_ranges() {
        let text = "one\ntwo\nthree\nfour";
        assert_eq!(select_lines(text, None, None), text);
        assert_eq!(select_lines(text, Some(2), Some(2)), "two\nthree\n");
        assert_eq!(select_lines(text, Some(3), None), "three\nfour");
        assert_eq!(select_lines(text, None, Some(1)), "one\n");
        assert_eq!(select_lines(text, Some(9), None), "");
    }
}
