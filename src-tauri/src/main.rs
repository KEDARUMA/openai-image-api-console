use base64::prelude::*;
use chrono::Local;
use crc32fast::Hasher;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Window};
use tokio::time::{sleep, timeout};

const IMAGE_ENDPOINT: &str = "https://api.openai.com/v1/responses";
const IMAGES_GENERATIONS_ENDPOINT: &str = "https://api.openai.com/v1/images/generations";
const IMAGES_EDITS_ENDPOINT: &str = "https://api.openai.com/v1/images/edits";
const HISTORY_LIMIT: usize = 100;
const APP_DIR_NAME: &str = "OpenAI Image API Console";
const OPENAI_REQUEST_TIMEOUT_SECS: u64 = 180;
const DEFAULT_APP_CONFIG: &str = include_str!("../default-config/app-config.json");
const DEFAULT_LOCALE_EN: &str = include_str!("../default-config/locales/en.json");
const DEFAULT_LOCALE_JA: &str = include_str!("../default-config/locales/ja.json");

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    api_key: String,
    #[serde(default = "default_language")]
    language: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateRequest {
    mode: String,
    model: String,
    prompt: String,
    filename: String,
    size: String,
    quality: String,
    output_format: String,
    output_compression: u8,
    background: String,
    moderation: String,
    action: String,
    count: u8,
    input_images: Vec<ImageAsset>,
    mask_image: Option<ImageAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageAsset {
    name: String,
    mime_type: String,
    data_url: String,
}

#[derive(Debug, Clone, Copy)]
struct ImageInfo {
    format: &'static str,
    width: u32,
    height: u32,
    has_alpha: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImageRequestBackend {
    Responses,
    ImagesGenerations,
    ImagesEdits,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedImage {
    path: String,
    data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateResponse {
    images: Vec<GeneratedImage>,
    logs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocaleInfo {
    code: String,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfigBundle {
    config: Value,
    locale: Value,
    available_locales: Vec<LocaleInfo>,
    config_dir: String,
    output_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationProgress {
    current: u8,
    total: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageMetadata {
    prompt: String,
    model: String,
    size: String,
    quality: String,
    output_format: String,
    background: String,
    moderation: String,
    action: String,
    count: u8,
    created_at: String,
}

fn default_language() -> String {
    "en".to_string()
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let _ = app;
    Ok(app_data_dir()?.join("settings.json"))
}

fn read_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let text = fs::read_to_string(&path)
        .map_err(|error| format!("設定を読み込めませんでした: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("設定ファイルの形式が不正です: {error}"))
}

fn output_dir() -> Result<PathBuf, String> {
    let dir = dirs::picture_dir()
        .ok_or("Pictures フォルダを取得できませんでした。")?
        .join(APP_DIR_NAME);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("画像保存フォルダを作成できませんでした: {error}"))?;
    Ok(dir)
}

fn image_request_backend(request: &GenerateRequest) -> ImageRequestBackend {
    if !uses_images_api_model(&request.model) {
        return ImageRequestBackend::Responses;
    }

    match request.mode.as_str() {
        "text" => ImageRequestBackend::ImagesGenerations,
        "image" | "edit-mask" => ImageRequestBackend::ImagesEdits,
        _ => ImageRequestBackend::Responses,
    }
}

fn uses_images_api_model(model: &str) -> bool {
    model.starts_with("gpt-image-") || model == "chatgpt-image-latest"
}

fn app_data_dir() -> Result<PathBuf, String> {
    let dir = dirs::data_dir()
        .ok_or("Application Support フォルダを取得できませんでした。")?
        .join(APP_DIR_NAME);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("アプリデータフォルダを作成できませんでした: {error}"))?;
    Ok(dir)
}

fn history_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("history.json"))
}

fn config_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("config"))
}

fn history_assets_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("history-assets"))
}

fn locales_dir() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("locales"))
}

fn ensure_default_config_files() -> Result<(), String> {
    let dir = config_dir()?;
    let locale_dir = locales_dir()?;
    fs::create_dir_all(&locale_dir)
        .map_err(|error| format!("config ディレクトリを作成できませんでした: {error}"))?;
    write_default_file_if_missing(&dir.join("app-config.json"), DEFAULT_APP_CONFIG)?;
    write_default_file_if_missing(&locale_dir.join("en.json"), DEFAULT_LOCALE_EN)?;
    write_default_file_if_missing(&locale_dir.join("ja.json"), DEFAULT_LOCALE_JA)?;
    Ok(())
}

fn write_default_file_if_missing(path: &Path, text: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    fs::write(path, text)
        .map_err(|error| format!("初期 config ファイルを作成できませんでした: {error}"))
}

fn read_json_file(path: &Path, label: &str) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("{label} を読み込めませんでした: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("{label} の JSON 形式が不正です: {error}"))
}

fn read_json_text(text: &str, label: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|error| format!("{label} の JSON 形式が不正です: {error}"))
}

fn load_app_config_value() -> Result<Value, String> {
    ensure_default_config_files()?;
    read_json_file(&config_dir()?.join("app-config.json"), "app-config.json")
}

fn sanitize_locale_code(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|char| char.is_ascii_alphanumeric() || matches!(char, '-' | '_'))
        .collect();
    if cleaned.is_empty() {
        default_language()
    } else {
        cleaned
    }
}

fn load_locale_value(language: &str) -> Result<Value, String> {
    ensure_default_config_files()?;
    let code = sanitize_locale_code(language);
    let locale_dir = locales_dir()?;
    let requested = locale_dir.join(format!("{code}.json"));
    let path = if requested.exists() {
        requested
    } else {
        locale_dir.join("en.json")
    };
    let default_text = if code == "ja" {
        DEFAULT_LOCALE_JA
    } else {
        DEFAULT_LOCALE_EN
    };
    let mut default_locale = read_json_text(default_text, &format!("default locale {code}"))?;
    let user_locale = read_json_file(&path, &format!("locale {}", path.to_string_lossy()))?;
    merge_json_objects(&mut default_locale, user_locale);
    Ok(default_locale)
}

fn merge_json_objects(base: &mut Value, overlay: Value) {
    let (Some(base_map), Some(overlay_map)) = (base.as_object_mut(), overlay.as_object()) else {
        return;
    };
    for (key, value) in overlay_map {
        base_map.insert(key.clone(), value.clone());
    }
}

fn list_available_locales() -> Result<Vec<LocaleInfo>, String> {
    ensure_default_config_files()?;
    let mut locales = Vec::new();
    for entry in fs::read_dir(locales_dir()?)
        .map_err(|error| format!("locale 一覧を読み込めませんでした: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("locale エントリを読み込めませんでした: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(code) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(ToString::to_string)
        else {
            continue;
        };
        let locale = read_json_file(&path, &format!("locale {}", path.to_string_lossy()))?;
        let name = locale
            .get("meta.name")
            .and_then(Value::as_str)
            .unwrap_or(&code)
            .to_string();
        locales.push(LocaleInfo { code, name });
    }
    locales.sort_by(|left, right| left.code.cmp(&right.code));
    Ok(locales)
}

fn request_delay_ms() -> Result<u64, String> {
    Ok(load_app_config_value()?
        .pointer("/limits/requestDelayMs")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(600_000))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    read_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("設定を保存形式に変換できませんでした: {error}"))?;
    fs::write(path, text).map_err(|error| format!("設定を保存できませんでした: {error}"))
}

#[tauri::command]
fn load_runtime_config(language: Option<String>) -> Result<RuntimeConfigBundle, String> {
    ensure_default_config_files()?;
    let config = load_app_config_value()?;
    let locale_code = language.unwrap_or_else(default_language);
    let locale = load_locale_value(&locale_code)?;
    Ok(RuntimeConfigBundle {
        config,
        locale,
        available_locales: list_available_locales()?,
        config_dir: config_dir()?.to_string_lossy().to_string(),
        output_dir: output_dir()?.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn load_locale(language: String) -> Result<Value, String> {
    load_locale_value(&language)
}

#[tauri::command]
fn load_history() -> Result<Vec<Value>, String> {
    let path = history_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let text = fs::read_to_string(&path)
        .map_err(|error| format!("履歴を読み込めませんでした: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("履歴 JSON の形式が不正です: {error}"))
}

#[tauri::command]
fn save_history(history: Vec<Value>) -> Result<(), String> {
    let path = history_path()?;
    let assets_dir = history_assets_dir()?;
    if history.is_empty() && assets_dir.exists() {
        fs::remove_dir_all(&assets_dir)
            .map_err(|error| format!("履歴画像フォルダを削除できませんでした: {error}"))?;
    }
    let sanitized = history
        .into_iter()
        .take(HISTORY_LIMIT)
        .map(|item| persist_history_item_assets(item, &assets_dir).map(strip_history_data_urls))
        .collect::<Result<Vec<_>, String>>()?;
    let text = serde_json::to_string_pretty(&sanitized)
        .map_err(|error| format!("履歴を JSON に変換できませんでした: {error}"))?;
    fs::write(path, text).map_err(|error| format!("履歴を保存できませんでした: {error}"))
}

#[tauri::command]
fn load_image_data_url(path: String) -> Result<String, String> {
    let image_path = PathBuf::from(&path);
    if !image_path.exists() {
        return Err(format!("画像ファイルが見つかりません: {path}"));
    }

    let bytes = fs::read(&image_path)
        .map_err(|error| format!("画像ファイルを読み込めませんでした: {error}"))?;
    Ok(format!(
        "data:{};base64,{}",
        media_type_for_path(&image_path),
        BASE64_STANDARD.encode(bytes)
    ))
}

#[tauri::command]
fn save_as_image(source_path: String) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(format!("保存元画像が見つかりません: {source_path}"));
    }

    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");
    let default_name = format!("openai-image.{extension}");
    let escaped_default_name = apple_script_string(&default_name);
    let script = format!(
        r#"set outputPath to choose file name with prompt "Save image as" default name "{}"
POSIX path of outputPath"#,
        escaped_default_name
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("保存ダイアログを開けませんでした: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("保存先が選択されませんでした: {stderr}"));
    }

    let destination_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let destination = PathBuf::from(&destination_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("保存先フォルダを作成できませんでした: {error}"))?;
    }
    fs::copy(&source, &destination)
        .map_err(|error| format!("画像を別名保存できませんでした: {error}"))?;
    copy_sidecar_json(&source, &destination)?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
fn show_in_finder(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("画像ファイルが見つかりません: {path}"));
    }
    let status = Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|error| format!("Finder を開けませんでした: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Finder で表示できませんでした: {path}"))
    }
}

#[tauri::command]
fn copy_image_to_clipboard(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("画像ファイルが見つかりません: {path}"));
    }
    let clipboard_class = clipboard_class_for_path(&path)?;
    let escaped = apple_script_string(&path);
    let script = format!(
        r#"set the clipboard to (read (POSIX file "{}") as «class {}»)"#,
        escaped, clipboard_class
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("クリップボードへコピーできませんでした: {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "画像をクリップボードへコピーできませんでした: {stderr}"
        ))
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !matches!(
        url.as_str(),
        "https://platform.openai.com/settings/organization/billing/overview"
            | "https://platform.openai.com/api-keys"
    ) {
        return Err(format!("この URL は開けません: {url}"));
    }
    let status = Command::new("open")
        .arg(&url)
        .status()
        .map_err(|error| format!("URL を開けませんでした: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("URL を開けませんでした: {url}"))
    }
}

fn apple_script_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn build_image_metadata(request: &GenerateRequest, count: u8, created_at: &str) -> ImageMetadata {
    ImageMetadata {
        prompt: request.prompt.clone(),
        model: request.model.clone(),
        size: request.size.clone(),
        quality: request.quality.clone(),
        output_format: request.output_format.clone(),
        background: request.background.clone(),
        moderation: request.moderation.clone(),
        action: request.action.clone(),
        count,
        created_at: created_at.to_string(),
    }
}

fn sidecar_json_path(image_path: &Path) -> PathBuf {
    image_path.with_extension("json")
}

fn copy_sidecar_json(source: &Path, destination: &Path) -> Result<(), String> {
    let source_json = sidecar_json_path(source);
    if !source_json.exists() {
        return Ok(());
    }
    fs::copy(&source_json, sidecar_json_path(destination))
        .map(|_| ())
        .map_err(|error| format!("sidecar JSON をコピーできませんでした: {error}"))
}

fn embed_image_metadata(
    bytes: &[u8],
    extension: &str,
    metadata_json: &str,
) -> Result<Vec<u8>, String> {
    match extension.to_ascii_lowercase().as_str() {
        "png" => embed_png_comment(bytes, metadata_json),
        "jpg" | "jpeg" => embed_jpeg_comment(bytes, metadata_json),
        "webp" => embed_webp_xmp(bytes, metadata_json),
        other => Err(format!("未対応の画像メタデータ形式です: {other}")),
    }
}

fn embed_png_comment(bytes: &[u8], metadata_json: &str) -> Result<Vec<u8>, String> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 33 || &bytes[..8] != PNG_SIGNATURE {
        return Err("PNG 形式として解析できませんでした".to_string());
    }

    let first_chunk_length = u32::from_be_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| "PNG chunk length が不正です".to_string())?,
    ) as usize;
    let first_chunk_type = &bytes[12..16];
    if first_chunk_type != b"IHDR" {
        return Err("PNG IHDR chunk が見つかりませんでした".to_string());
    }
    let insert_at = 8 + 12 + first_chunk_length;
    if bytes.len() < insert_at {
        return Err("PNG chunk サイズが不正です".to_string());
    }

    let mut chunk_data = Vec::new();
    chunk_data.extend_from_slice(b"Comment");
    chunk_data.push(0);
    chunk_data.extend_from_slice(metadata_json.as_bytes());
    let chunk = png_chunk(*b"tEXt", &chunk_data)?;

    let mut output = Vec::with_capacity(bytes.len() + chunk.len());
    output.extend_from_slice(&bytes[..insert_at]);
    output.extend_from_slice(&chunk);
    output.extend_from_slice(&bytes[insert_at..]);
    Ok(output)
}

fn png_chunk(chunk_type: [u8; 4], data: &[u8]) -> Result<Vec<u8>, String> {
    let length =
        u32::try_from(data.len()).map_err(|_| "PNG metadata chunk が大きすぎます".to_string())?;
    let mut chunk = Vec::with_capacity(data.len() + 12);
    chunk.extend_from_slice(&length.to_be_bytes());
    chunk.extend_from_slice(&chunk_type);
    chunk.extend_from_slice(data);
    let mut hasher = Hasher::new();
    hasher.update(&chunk_type);
    hasher.update(data);
    chunk.extend_from_slice(&hasher.finalize().to_be_bytes());
    Ok(chunk)
}

fn embed_jpeg_comment(bytes: &[u8], metadata_json: &str) -> Result<Vec<u8>, String> {
    if bytes.len() < 2 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return Err("JPEG SOI marker が見つかりませんでした".to_string());
    }
    let comment = metadata_json.as_bytes();
    let segment_length = u16::try_from(comment.len() + 2)
        .map_err(|_| "JPEG Comment metadata が大きすぎます".to_string())?;

    let mut output = Vec::with_capacity(bytes.len() + comment.len() + 4);
    output.extend_from_slice(&bytes[..2]);
    output.extend_from_slice(&[0xff, 0xfe]);
    output.extend_from_slice(&segment_length.to_be_bytes());
    output.extend_from_slice(comment);
    output.extend_from_slice(&bytes[2..]);
    Ok(output)
}

fn embed_webp_xmp(bytes: &[u8], metadata_json: &str) -> Result<Vec<u8>, String> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("WebP RIFF header が見つかりませんでした".to_string());
    }
    let xmp = xmp_packet(metadata_json);
    let xmp_bytes = xmp.as_bytes();
    let chunk_size = u32::try_from(xmp_bytes.len())
        .map_err(|_| "WebP XMP metadata が大きすぎます".to_string())?;
    let mut output = Vec::with_capacity(bytes.len() + xmp_bytes.len() + 9);
    output.extend_from_slice(bytes);
    output.extend_from_slice(b"XMP ");
    output.extend_from_slice(&chunk_size.to_le_bytes());
    output.extend_from_slice(xmp_bytes);
    if xmp_bytes.len() % 2 == 1 {
        output.push(0);
    }
    let riff_size =
        u32::try_from(output.len() - 8).map_err(|_| "WebP ファイルが大きすぎます".to_string())?;
    output[4..8].copy_from_slice(&riff_size.to_le_bytes());
    Ok(output)
}

fn xmp_packet(metadata_json: &str) -> String {
    let escaped = escape_xml(metadata_json);
    format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="openai-image-api">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">{escaped}</rdf:li>
        </rdf:Alt>
      </dc:description>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#
    )
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn clipboard_class_for_path(path: &str) -> Result<&'static str, String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match extension.as_str() {
        "png" => Ok("PNGf"),
        "jpg" | "jpeg" => Ok("JPEG"),
        "tif" | "tiff" => Ok("TIFF"),
        "webp" => Err("WEBP の画像データコピーは macOS クリップボード経由では未対応です。PNG または JPEG で生成してください。".to_string()),
        _ => Err(format!("この画像形式はクリップボードコピー未対応です: {extension}")),
    }
}

#[tauri::command]
async fn generate_image(
    app: AppHandle,
    window: Window,
    request: GenerateRequest,
) -> Result<GenerateResponse, String> {
    let mut logs = vec![format!(
        "backend: start mode={} model={} action={} size={} quality={} format={} count={} input_images={} mask={}",
        request.mode,
        request.model,
        request.action,
        request.size,
        request.quality,
        request.output_format,
        request.count,
        request.input_images.len(),
        request.mask_image.is_some()
    )];
    emit_log(&window, logs.last().expect("initial log exists"));
    let settings = read_settings(&app)?;
    let api_key = settings.api_key.trim();
    if api_key.is_empty() {
        return Err("設定メニューで API キーを保存してください。".to_string());
    }

    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("prompt を入力してください。".to_string());
    }

    let count = request.count.clamp(1, 8);
    let images_dir = output_dir()?;
    push_log(
        &window,
        &mut logs,
        format!("backend: output_dir={}", images_dir.to_string_lossy()),
    );
    let file_base = sanitize_file_base(&request.filename);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(OPENAI_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("HTTP client を作成できませんでした: {error}"))?;
    let backend = image_request_backend(&request);
    let mut images = Vec::new();
    if request.mode == "edit-mask" {
        validate_edit_mask_assets(&window, &request, &mut logs)?;
    }

    match backend {
        ImageRequestBackend::ImagesGenerations => {
            push_log(
                &window,
                &mut logs,
                "backend: file upload skipped; using images generations".to_string(),
            );
        }
        ImageRequestBackend::ImagesEdits => {
            push_log(
                &window,
                &mut logs,
                "backend: file upload skipped; using images edits multipart".to_string(),
            );
        }
        ImageRequestBackend::Responses => {
            push_log(
                &window,
                &mut logs,
                "backend: file upload skipped; using responses".to_string(),
            );
        }
    }
    let delay_ms = request_delay_ms()?;

    for index in 0..count {
        emit_progress(&window, index + 1, count);
        let request_timeout = Duration::from_secs(OPENAI_REQUEST_TIMEOUT_SECS);
        let base64 = match backend {
            ImageRequestBackend::ImagesGenerations => match timeout(
                request_timeout,
                request_images_generation_base64(
                    &window, &client, api_key, &request, index, count, &mut logs,
                ),
            )
            .await
            {
                Ok(result) => result?,
                Err(_) => {
                    let message = format!(
                        "OpenAI Images Generations API timeout after {}s",
                        OPENAI_REQUEST_TIMEOUT_SECS
                    );
                    push_log(
                        &window,
                        &mut logs,
                        format!(
                            "backend: images generations timeout after {}s",
                            OPENAI_REQUEST_TIMEOUT_SECS
                        ),
                    );
                    return Err(format!("{message}\n\nDebug logs:\n{}", logs.join("\n")));
                }
            },
            ImageRequestBackend::ImagesEdits => match timeout(
                request_timeout,
                request_images_edit_base64(
                    &window, &client, api_key, &request, index, count, &mut logs,
                ),
            )
            .await
            {
                Ok(result) => result?,
                Err(_) => {
                    let message = format!(
                        "OpenAI Images Edits API timeout after {}s",
                        OPENAI_REQUEST_TIMEOUT_SECS
                    );
                    push_log(
                        &window,
                        &mut logs,
                        format!(
                            "backend: images edits timeout after {}s",
                            OPENAI_REQUEST_TIMEOUT_SECS
                        ),
                    );
                    return Err(format!("{message}\n\nDebug logs:\n{}", logs.join("\n")));
                }
            },
            ImageRequestBackend::Responses => match timeout(
                request_timeout,
                request_responses_base64(
                    &window, &client, api_key, &request, index, count, &mut logs,
                ),
            )
            .await
            {
                Ok(result) => result?,
                Err(_) => {
                    let message = format!(
                        "OpenAI Responses API timeout after {}s",
                        OPENAI_REQUEST_TIMEOUT_SECS
                    );
                    push_log(
                        &window,
                        &mut logs,
                        format!(
                            "backend: responses timeout after {}s",
                            OPENAI_REQUEST_TIMEOUT_SECS
                        ),
                    );
                    return Err(format!("{message}\n\nDebug logs:\n{}", logs.join("\n")));
                }
            },
        };
        let mut bytes = BASE64_STANDARD
            .decode(base64.as_bytes())
            .map_err(|error| format!("画像データをデコードできませんでした: {error}"))?;
        push_log(
            &window,
            &mut logs,
            format!("backend: decoded image bytes={}", bytes.len()),
        );

        let created_at = Local::now().to_rfc3339();
        let metadata = build_image_metadata(&request, count, &created_at);
        let metadata_json = serde_json::to_string_pretty(&metadata)
            .map_err(|error| format!("画像メタデータを JSON に変換できませんでした: {error}"))?;
        let extension = if request.output_format == "jpeg" {
            "jpg"
        } else {
            request.output_format.as_str()
        };
        match embed_image_metadata(&bytes, extension, &metadata_json) {
            Ok(updated) => {
                bytes = updated;
                push_log(
                    &window,
                    &mut logs,
                    "backend: embedded image metadata".to_string(),
                );
            }
            Err(error) => {
                push_log(
                    &window,
                    &mut logs,
                    format!("backend: metadata embed warning={error}"),
                );
            }
        }
        let suffix = if count == 1 {
            String::new()
        } else {
            format!("-{:02}", index + 1)
        };
        let output_path =
            unique_output_path(&images_dir, &format!("{file_base}{suffix}"), extension);
        fs::write(&output_path, bytes)
            .map_err(|error| format!("画像を保存できませんでした: {error}"))?;
        push_log(
            &window,
            &mut logs,
            format!("backend: saved={}", output_path.to_string_lossy()),
        );

        let generated_image = GeneratedImage {
            path: output_path.to_string_lossy().to_string(),
            data_url: format!(
                "data:image/{};base64,{}",
                request.output_format,
                BASE64_STANDARD.encode(
                    fs::read(&output_path)
                        .map_err(|error| format!("保存画像を読み込めませんでした: {error}"))?
                )
            ),
        };
        emit_generated_image(&window, &generated_image);
        images.push(generated_image);

        if index + 1 < count && delay_ms > 0 {
            push_log(
                &window,
                &mut logs,
                format!("backend: waiting {}ms before next request", delay_ms),
            );
            sleep(Duration::from_millis(delay_ms)).await;
        }
    }

    push_log(
        &window,
        &mut logs,
        format!("backend: complete images={}", images.len()),
    );
    Ok(GenerateResponse { images, logs })
}

async fn request_responses_base64(
    window: &Window,
    client: &reqwest::Client,
    api_key: &str,
    request: &GenerateRequest,
    index: u8,
    count: u8,
    logs: &mut Vec<String>,
) -> Result<String, String> {
    push_log(
        window,
        logs,
        format!("backend: responses request {}/{} start", index + 1, count),
    );
    let body = build_request_body(request);
    push_log(
        window,
        logs,
        format!(
            "backend: responses request summary={}",
            summarize_request_body(&body)
        ),
    );
    push_log(
        window,
        logs,
        format!(
            "backend: responses request json={}",
            safe_request_log_json(request)
        ),
    );
    let response = client
        .post(IMAGE_ENDPOINT)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("OpenAI API に接続できませんでした: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_else(|_| String::new());
        push_log(
            window,
            logs,
            format!("backend: responses error status={status} body={text}"),
        );
        return Err(format!(
            "{}\n\nDebug logs:\n{}",
            format!("OpenAI API error {status}: {text}"),
            logs.join("\n")
        ));
    }

    push_log(
        window,
        logs,
        format!("backend: responses status={}", response.status()),
    );
    let data: Value = response
        .json()
        .await
        .map_err(|error| format!("OpenAI API のレスポンスを解析できませんでした: {error}"))?;

    push_log(
        window,
        logs,
        format!(
            "backend: responses json summary={}",
            summarize_response_json(&data)
        ),
    );
    image_base64_from_response(window, logs, &data)
}

async fn request_images_generation_base64(
    window: &Window,
    client: &reqwest::Client,
    api_key: &str,
    request: &GenerateRequest,
    index: u8,
    count: u8,
    logs: &mut Vec<String>,
) -> Result<String, String> {
    push_log(
        window,
        logs,
        format!(
            "backend: images generations request {}/{} start",
            index + 1,
            count
        ),
    );
    let body = build_images_generation_body(request);
    push_log(
        window,
        logs,
        format!(
            "backend: images generations endpoint=/v1/images/generations model={} size={} quality={} format={}",
            request.model, request.size, request.quality, request.output_format
        ),
    );
    push_log(
        window,
        logs,
        format!(
            "backend: images generations request json={}",
            summarize_images_generation_body(&body)
        ),
    );

    let response = client
        .post(IMAGES_GENERATIONS_ENDPOINT)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("OpenAI Images Generations API に接続できませんでした: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_else(|_| String::new());
        push_log(
            window,
            logs,
            format!("backend: images generations error status={status} body={text}"),
        );
        return Err(format!(
            "{}\n\nDebug logs:\n{}",
            format!("OpenAI Images Generations API error {status}: {text}"),
            logs.join("\n")
        ));
    }

    push_log(
        window,
        logs,
        format!("backend: images generations status={}", response.status()),
    );
    let data: Value = response.json().await.map_err(|error| {
        format!("OpenAI Images Generations API のレスポンスを解析できませんでした: {error}")
    })?;
    push_log(
        window,
        logs,
        format!(
            "backend: images generations json summary={}",
            summarize_response_json(&data)
        ),
    );
    image_base64_from_response(window, logs, &data)
}

async fn request_images_edit_base64(
    window: &Window,
    client: &reqwest::Client,
    api_key: &str,
    request: &GenerateRequest,
    index: u8,
    count: u8,
    logs: &mut Vec<String>,
) -> Result<String, String> {
    push_log(
        window,
        logs,
        format!(
            "backend: images edits request {}/{} start",
            index + 1,
            count
        ),
    );
    push_log(
        window,
        logs,
        format!(
            "backend: images edits endpoint=/v1/images/edits model={} size={} quality={} format={} image_count={}",
            request.model,
            request.size,
            request.quality,
            request.output_format,
            request.input_images.len()
        ),
    );
    push_log(
        window,
        logs,
        format!(
            "backend: images edits multipart fields={}",
            summarize_images_edits_fields(request)
        ),
    );
    let form = build_images_edits_form(request)?;
    let response = client
        .post(IMAGES_EDITS_ENDPOINT)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("OpenAI Images Edits API に接続できませんでした: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_else(|_| String::new());
        push_log(
            window,
            logs,
            format!("backend: images edits error status={status} body={text}"),
        );
        return Err(format!(
            "{}\n\nDebug logs:\n{}",
            format!("OpenAI Images Edits API error {status}: {text}"),
            logs.join("\n")
        ));
    }

    push_log(
        window,
        logs,
        format!("backend: images edits status={}", response.status()),
    );
    let data: Value = response.json().await.map_err(|error| {
        format!("OpenAI Images Edits API のレスポンスを解析できませんでした: {error}")
    })?;
    push_log(
        window,
        logs,
        format!(
            "backend: images edits json summary={}",
            summarize_response_json(&data)
        ),
    );
    image_base64_from_response(window, logs, &data)
}

fn image_base64_from_response(
    window: &Window,
    logs: &mut Vec<String>,
    data: &Value,
) -> Result<String, String> {
    match find_image_base64(data) {
        Some(value) => Ok(value),
        None => {
            push_log(window, logs, "backend: image base64 not found".to_string());
            push_log(
                window,
                logs,
                format!(
                    "backend: response message summary={}",
                    summarize_response_messages(data)
                ),
            );
            Err(format!(
                "画像データをレスポンスから見つけられませんでした。\n\nDebug logs:\n{}",
                logs.join("\n")
            ))
        }
    }
}

fn build_images_edits_form(request: &GenerateRequest) -> Result<reqwest::multipart::Form, String> {
    if request.input_images.is_empty() {
        return Err("入力画像を追加してください。".to_string());
    }

    let mut form = reqwest::multipart::Form::new()
        .text("model", request.model.clone())
        .text("prompt", request.prompt.clone());

    if request.mode == "edit-mask" {
        let mask_image = request
            .mask_image
            .as_ref()
            .ok_or("マスク画像を追加してください。".to_string())?;
        form = form.part("mask", multipart_part_from_asset(mask_image, "マスク画像")?);
    }

    for image in &request.input_images {
        form = form.part("image[]", multipart_part_from_asset(image, "入力画像")?);
    }

    form = add_multipart_text_if_not_auto(form, "size", &request.size);
    form = add_multipart_text_if_not_auto(form, "quality", &request.quality);
    form = add_multipart_text_if_not_auto(form, "output_format", &request.output_format);
    form = add_multipart_text_if_not_auto(form, "background", &request.background);
    form = add_multipart_text_if_not_auto(form, "moderation", &request.moderation);
    if matches!(request.output_format.as_str(), "jpeg" | "webp") {
        form = form.text(
            "output_compression",
            request.output_compression.clamp(0, 100).to_string(),
        );
    }

    Ok(form)
}

fn build_images_generation_body(request: &GenerateRequest) -> Value {
    let mut body = Map::new();
    body.insert("model".to_string(), json!(request.model));
    body.insert("prompt".to_string(), json!(request.prompt));
    insert_if_not_auto(&mut body, "size", &request.size);
    insert_if_not_auto(&mut body, "quality", &request.quality);
    insert_if_not_auto(&mut body, "output_format", &request.output_format);
    insert_if_not_auto(&mut body, "background", &request.background);
    insert_if_not_auto(&mut body, "moderation", &request.moderation);
    if matches!(request.output_format.as_str(), "jpeg" | "webp") {
        body.insert(
            "output_compression".to_string(),
            json!(request.output_compression.clamp(0, 100)),
        );
    }
    Value::Object(body)
}

fn summarize_images_generation_body(body: &Value) -> String {
    match body {
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            keys.join(",")
        }
        _ => "unknown".to_string(),
    }
}

fn multipart_part_from_asset(
    image: &ImageAsset,
    label: &str,
) -> Result<reqwest::multipart::Part, String> {
    let bytes = decode_data_url(&image.data_url)?;
    let filename = sanitize_file_base(&image.name);
    let extension = extension_for_mime(&image.mime_type);
    reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("{filename}.{extension}"))
        .mime_str(&image.mime_type)
        .map_err(|error| format!("{label} MIME type が不正です: {error}"))
}

fn add_multipart_text_if_not_auto(
    form: reqwest::multipart::Form,
    key: &'static str,
    value: &str,
) -> reqwest::multipart::Form {
    if !value.trim().is_empty() && value != "auto" {
        form.text(key, value.to_string())
    } else {
        form
    }
}

fn summarize_images_edits_fields(request: &GenerateRequest) -> String {
    let mut fields = vec!["model", "prompt", "image[]"];
    if request.mode == "edit-mask" {
        fields.push("mask");
    }
    if request.size != "auto" {
        fields.push("size");
    }
    if request.quality != "auto" {
        fields.push("quality");
    }
    if request.output_format != "auto" {
        fields.push("output_format");
    }
    if request.background != "auto" {
        fields.push("background");
    }
    if request.moderation != "auto" {
        fields.push("moderation");
    }
    if matches!(request.output_format.as_str(), "jpeg" | "webp") {
        fields.push("output_compression");
    }
    fields.join(",")
}

fn build_request_body(request: &GenerateRequest) -> Value {
    let mut tool = Map::new();
    tool.insert("type".to_string(), json!("image_generation"));
    insert_if_not_auto(&mut tool, "quality", &request.quality);
    insert_if_not_auto(&mut tool, "output_format", &request.output_format);
    insert_if_not_auto(&mut tool, "background", &request.background);
    insert_if_not_auto(&mut tool, "size", &request.size);
    insert_if_not_auto(&mut tool, "moderation", &request.moderation);
    if request.mode == "edit-mask" {
        tool.insert("action".to_string(), json!("edit"));
        if let Some(mask_image) = request.mask_image.as_ref() {
            tool.insert(
                "input_image_mask".to_string(),
                json!({
                    "image_url": mask_image.data_url
                }),
            );
        }
    } else {
        insert_if_not_auto(&mut tool, "action", &request.action);
    }

    if matches!(request.output_format.as_str(), "jpeg" | "webp") {
        tool.insert(
            "output_compression".to_string(),
            json!(request.output_compression.clamp(0, 100)),
        );
    }

    let input = build_input_content(request);

    let mut body = Map::new();
    body.insert("model".to_string(), json!(request.model));
    body.insert("input".to_string(), input);
    body.insert("tools".to_string(), json!([Value::Object(tool)]));

    body.insert(
        "tool_choice".to_string(),
        json!({
            "type": "image_generation"
        }),
    );

    Value::Object(body)
}

fn build_input_content(request: &GenerateRequest) -> Value {
    if request.mode == "text" {
        return json!(request.prompt);
    }

    let mut content = vec![json!({
        "type": "input_text",
        "text": request.prompt
    })];

    for image in &request.input_images {
        content.push(json!({
            "type": "input_image",
            "image_url": image.data_url
        }));
    }

    json!([
        {
            "role": "user",
            "content": content
        }
    ])
}

fn insert_if_not_auto(tool: &mut Map<String, Value>, key: &str, value: &str) {
    if !value.trim().is_empty() && value != "auto" {
        tool.insert(key.to_string(), json!(value));
    }
}

fn sanitize_file_base(filename: &str) -> String {
    let without_ext = filename
        .trim()
        .trim_end_matches(".png")
        .trim_end_matches(".webp")
        .trim_end_matches(".jpg")
        .trim_end_matches(".jpeg");
    let cleaned: String = without_ext
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '.' | '_' | '-') {
                char
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('-');
    if cleaned.is_empty() {
        format!("openai-image-{}", Local::now().format("%Y%m%d-%H%M%S"))
    } else {
        cleaned.to_string()
    }
}

fn unique_output_path(dir: &Path, file_base: &str, extension: &str) -> PathBuf {
    let first = dir.join(format!("{file_base}.{extension}"));
    if !first.exists() {
        return first;
    }

    for index in 2..1000 {
        let candidate = dir.join(format!("{file_base}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    dir.join(format!(
        "{file_base}-{}.{}",
        Local::now().format("%Y%m%d-%H%M%S"),
        extension
    ))
}

fn find_image_base64(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let stripped = strip_data_url_prefix(text)
                .split_whitespace()
                .collect::<String>();
            if looks_like_base64_image(&stripped) {
                Some(stripped)
            } else {
                None
            }
        }
        Value::Array(items) => items.iter().find_map(find_image_base64),
        Value::Object(map) => {
            for key in ["result", "image_base64", "b64_json", "data"] {
                if let Some(Value::String(text)) = map.get(key) {
                    let stripped = strip_data_url_prefix(text)
                        .split_whitespace()
                        .collect::<String>();
                    if looks_like_base64_image(&stripped) {
                        return Some(stripped);
                    }
                }
            }

            map.values().find_map(find_image_base64)
        }
        _ => None,
    }
}

fn strip_data_url_prefix(value: &str) -> &str {
    if let Some(index) = value.find(";base64,") {
        &value[(index + 8)..]
    } else {
        value
    }
}

fn looks_like_base64_image(value: &str) -> bool {
    value.len() > 1000
        && value
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '+' | '/' | '='))
}

fn push_log(window: &Window, logs: &mut Vec<String>, message: String) {
    emit_log(window, &message);
    logs.push(message);
}

fn emit_log(window: &Window, message: &str) {
    let _ = window.emit("debug-log", message);
}

fn emit_progress(window: &Window, current: u8, total: u8) {
    let _ = window.emit("generation-progress", GenerationProgress { current, total });
}

fn emit_generated_image(window: &Window, image: &GeneratedImage) {
    let _ = window.emit("generated-image", image);
}

fn decode_data_url(value: &str) -> Result<Vec<u8>, String> {
    let Some(index) = value.find(";base64,") else {
        return Err("画像 data URL の形式が不正です。".to_string());
    };
    BASE64_STANDARD
        .decode(value[(index + 8)..].as_bytes())
        .map_err(|error| format!("画像 data URL をデコードできませんでした: {error}"))
}

fn validate_edit_mask_assets(
    window: &Window,
    request: &GenerateRequest,
    logs: &mut Vec<String>,
) -> Result<(), String> {
    let Some(input_image) = request.input_images.first() else {
        return Err(error_with_logs("入力画像を追加してください。", logs));
    };
    let Some(mask_image) = request.mask_image.as_ref() else {
        return Err(error_with_logs("マスク画像を追加してください。", logs));
    };

    let input_bytes = decode_data_url(&input_image.data_url).map_err(|error| {
        error_with_logs(&format!("入力画像を検証できませんでした: {error}"), logs)
    })?;
    let mask_bytes = decode_data_url(&mask_image.data_url).map_err(|error| {
        error_with_logs(&format!("マスク画像を検証できませんでした: {error}"), logs)
    })?;
    let input_info = parse_image_info(&input_bytes).map_err(|error| {
        error_with_logs(
            &format!("入力画像の形式を検証できませんでした: {error}"),
            logs,
        )
    })?;
    let mask_info = parse_image_info(&mask_bytes).map_err(|error| {
        error_with_logs(
            &format!("マスク画像の形式を検証できませんでした: {error}"),
            logs,
        )
    })?;

    push_log(
        window,
        logs,
        format!(
            "backend: validate input image name={} mime={} bytes={} format={} size={}x{} alpha={}",
            input_image.name,
            input_image.mime_type,
            input_bytes.len(),
            input_info.format,
            input_info.width,
            input_info.height,
            input_info.has_alpha
        ),
    );
    push_log(
        window,
        logs,
        format!(
            "backend: validate mask image name={} mime={} bytes={} format={} size={}x{} alpha={} mode=rgba-rgb-alpha-same",
            mask_image.name,
            mask_image.mime_type,
            mask_bytes.len(),
            mask_info.format,
            mask_info.width,
            mask_info.height,
            mask_info.has_alpha
        ),
    );

    if input_info.width != mask_info.width || input_info.height != mask_info.height {
        return Err(error_with_logs(
            &format!(
                "入力画像とマスク画像のサイズが一致していません。入力: {}x{}、マスク: {}x{}",
                input_info.width, input_info.height, mask_info.width, mask_info.height
            ),
            logs,
        ));
    }
    if mask_info.format != "png" {
        return Err(error_with_logs(
            &format!(
                "マスク画像は alpha channel 付き PNG が必要です。現在の形式: {}",
                mask_info.format
            ),
            logs,
        ));
    }
    if !mask_info.has_alpha {
        return Err(error_with_logs("マスク画像に alpha channel がありません。透明背景を含む PNG マスクを指定してください。", logs));
    }

    push_log(window, logs, "backend: edit-mask validation ok".to_string());
    Ok(())
}

fn parse_image_info(bytes: &[u8]) -> Result<ImageInfo, String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return parse_png_info(bytes);
    }
    if bytes.starts_with(b"\xff\xd8") {
        return parse_jpeg_info(bytes);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return parse_webp_info(bytes);
    }
    Err("対応していない画像形式です。PNG/JPEG/WebP を指定してください。".to_string())
}

fn parse_png_info(bytes: &[u8]) -> Result<ImageInfo, String> {
    if bytes.len() < 33 || &bytes[12..16] != b"IHDR" {
        return Err("PNG IHDR chunk を読み取れませんでした。".to_string());
    }
    let width = read_be_u32(&bytes[16..20])?;
    let height = read_be_u32(&bytes[20..24])?;
    let color_type = bytes[25];
    let has_alpha = matches!(color_type, 4 | 6) || png_has_trns_chunk(bytes);
    Ok(ImageInfo {
        format: "png",
        width,
        height,
        has_alpha,
    })
}

fn png_has_trns_chunk(bytes: &[u8]) -> bool {
    let mut offset = 8usize;
    while offset + 12 <= bytes.len() {
        let Ok(length) = read_be_u32(&bytes[offset..offset + 4]) else {
            return false;
        };
        let length = length as usize;
        let chunk_type_start = offset + 4;
        let data_start = offset + 8;
        let Some(data_end) = data_start.checked_add(length) else {
            return false;
        };
        let Some(next_offset) = data_end.checked_add(4) else {
            return false;
        };
        if next_offset > bytes.len() {
            return false;
        }
        let chunk_type = &bytes[chunk_type_start..chunk_type_start + 4];
        if chunk_type == b"tRNS" && length > 0 {
            return true;
        }
        if chunk_type == b"IEND" {
            return false;
        }
        offset = next_offset;
    }
    false
}

fn parse_jpeg_info(bytes: &[u8]) -> Result<ImageInfo, String> {
    let mut offset = 2usize;
    while offset + 4 <= bytes.len() {
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        if offset >= bytes.len() {
            break;
        }
        let marker = bytes[offset];
        offset += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if offset + 2 > bytes.len() {
            break;
        }
        let segment_length = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        if segment_length < 2 || offset + segment_length > bytes.len() {
            return Err("JPEG segment が不正です。".to_string());
        }
        if is_jpeg_sof_marker(marker) {
            if segment_length < 7 {
                return Err("JPEG SOF segment が不正です。".to_string());
            }
            let height = u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32;
            return Ok(ImageInfo {
                format: "jpeg",
                width,
                height,
                has_alpha: false,
            });
        }
        offset += segment_length;
    }
    Err("JPEG のサイズを読み取れませんでした。".to_string())
}

fn is_jpeg_sof_marker(marker: u8) -> bool {
    matches!(
        marker,
        0xc0 | 0xc1 | 0xc2 | 0xc3 | 0xc5 | 0xc6 | 0xc7 | 0xc9 | 0xca | 0xcb | 0xcd | 0xce | 0xcf
    )
}

fn parse_webp_info(bytes: &[u8]) -> Result<ImageInfo, String> {
    let mut offset = 12usize;
    while offset + 8 <= bytes.len() {
        let chunk_type = &bytes[offset..offset + 4];
        let length = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let data_start = offset + 8;
        let Some(data_end) = data_start.checked_add(length) else {
            return Err("WebP chunk が不正です。".to_string());
        };
        if data_end > bytes.len() {
            return Err("WebP chunk が不正です。".to_string());
        }
        let data = &bytes[data_start..data_end];
        match chunk_type {
            b"VP8X" if data.len() >= 10 => {
                let width = 1 + read_le24(&data[4..7]);
                let height = 1 + read_le24(&data[7..10]);
                return Ok(ImageInfo {
                    format: "webp",
                    width,
                    height,
                    has_alpha: data[0] & 0x10 != 0,
                });
            }
            b"VP8L" if data.len() >= 5 && data[0] == 0x2f => {
                let width = 1 + (((data[2] as u32 & 0x3f) << 8) | data[1] as u32);
                let height = 1
                    + (((data[4] as u32 & 0x0f) << 10)
                        | ((data[3] as u32) << 2)
                        | ((data[2] as u32 & 0xc0) >> 6));
                return Ok(ImageInfo {
                    format: "webp",
                    width,
                    height,
                    has_alpha: data[4] & 0x10 != 0,
                });
            }
            b"VP8 " if data.len() >= 10 && data[3..6] == [0x9d, 0x01, 0x2a] => {
                let width = u16::from_le_bytes([data[6], data[7]]) as u32 & 0x3fff;
                let height = u16::from_le_bytes([data[8], data[9]]) as u32 & 0x3fff;
                return Ok(ImageInfo {
                    format: "webp",
                    width,
                    height,
                    has_alpha: false,
                });
            }
            _ => {}
        }
        offset = data_end + (length % 2);
    }
    Err("WebP のサイズを読み取れませんでした。".to_string())
}

fn read_be_u32(bytes: &[u8]) -> Result<u32, String> {
    let value: [u8; 4] = bytes
        .try_into()
        .map_err(|_| "u32 を読み取れませんでした。".to_string())?;
    Ok(u32::from_be_bytes(value))
}

fn read_le24(bytes: &[u8]) -> u32 {
    (bytes[0] as u32) | ((bytes[1] as u32) << 8) | ((bytes[2] as u32) << 16)
}

fn error_with_logs(message: &str, logs: &[String]) -> String {
    format!("{message}\n\nDebug logs:\n{}", logs.join("\n"))
}

fn summarize_request_body(value: &Value) -> String {
    let input_kind = if value.get("input").and_then(Value::as_str).is_some() {
        "text"
    } else {
        "messages"
    };
    let tools = value
        .get("tools")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    format!("input={input_kind} tools={tools}")
}

fn summarize_response_json(value: &Value) -> String {
    if let Some(id) = value.get("id").and_then(Value::as_str) {
        let output = value.get("output").and_then(Value::as_array);
        let output_count = output.map(|items| items.len()).unwrap_or(0);
        let output_types = output
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("type").and_then(Value::as_str))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        return format!("id={id} output_count={output_count} output_types={output_types:?}");
    }

    value
        .as_object()
        .map(|object| format!("keys={:?}", object.keys().collect::<Vec<_>>()))
        .unwrap_or_else(|| "non_object_response".to_string())
}

fn summarize_response_messages(value: &Value) -> String {
    let Some(output) = value.get("output").and_then(Value::as_array) else {
        return "output not found".to_string();
    };

    let mut messages = Vec::new();
    for item in output {
        if item.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        if let Some(content) = item.get("content").and_then(Value::as_array) {
            for content_item in content {
                if let Some(text) = content_item
                    .get("text")
                    .or_else(|| content_item.get("output_text"))
                    .and_then(Value::as_str)
                {
                    messages.push(text.to_string());
                }
            }
        }
    }

    if messages.is_empty() {
        "message text not found".to_string()
    } else {
        let joined = messages.join("\n");
        if joined.chars().count() > 800 {
            format!(
                "{}... <omitted>",
                joined.chars().take(800).collect::<String>()
            )
        } else {
            joined
        }
    }
}

fn safe_request_log_json(request: &GenerateRequest) -> String {
    let preview = if request.mode == "text" {
        json!({
            "model": request.model,
            "input": {
                "type": "text",
                "chars": request.prompt.chars().count()
            },
            "tools": [{
                "type": "image_generation",
                "action": request.action,
                "size": request.size,
                "quality": request.quality,
                "output_format": request.output_format,
                "background": request.background,
                "moderation": request.moderation,
            }],
            "tool_choice": { "type": "image_generation" }
        })
    } else {
        json!({
            "model": request.model,
            "input": {
                "type": "messages",
                "prompt_chars": request.prompt.chars().count(),
                "input_images": request.input_images.iter().map(summarize_image_asset).collect::<Vec<_>>(),
                "mask": request.mask_image.as_ref().map(summarize_image_asset),
            },
            "tools": [{
                "type": "image_generation",
                "action": request.action,
                "size": request.size,
                "quality": request.quality,
                "output_format": request.output_format,
                "background": request.background,
                "moderation": request.moderation,
            }],
            "tool_choice": { "type": "image_generation" }
        })
    };
    serde_json::to_string(&preview)
        .unwrap_or_else(|_| "<failed to serialize request preview>".to_string())
}

fn summarize_image_asset(image: &ImageAsset) -> Value {
    json!({
        "name": image.name,
        "mime_type": image.mime_type,
        "data_url_chars": image.data_url.len(),
    })
}

fn strip_history_data_urls(value: Value) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.into_iter().map(strip_history_data_urls).collect())
        }
        Value::Object(map) => {
            let mut stripped = Map::new();
            for (key, item) in map {
                if key == "dataUrl" || key == "data_url" {
                    stripped.insert(key, json!(""));
                } else {
                    stripped.insert(key, strip_history_data_urls(item));
                }
            }
            Value::Object(stripped)
        }
        other => other,
    }
}

fn persist_history_item_assets(mut item: Value, assets_dir: &Path) -> Result<Value, String> {
    let history_id = item
        .get("id")
        .and_then(Value::as_str)
        .map(sanitize_file_base)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("history-{}", Local::now().format("%Y%m%d-%H%M%S")));
    let item_dir = assets_dir.join(history_id);
    fs::create_dir_all(&item_dir)
        .map_err(|error| format!("履歴画像フォルダを作成できませんでした: {error}"))?;

    let Some(settings) = item.get_mut("settings").and_then(Value::as_object_mut) else {
        return Ok(item);
    };

    if let Some(input_images) = settings
        .get_mut("inputImages")
        .and_then(Value::as_array_mut)
    {
        for (index, asset) in input_images.iter_mut().enumerate() {
            if let Some(asset) = asset.as_object_mut() {
                persist_history_asset(asset, &item_dir, &format!("input-{:02}", index + 1))?;
            }
        }
    }

    if let Some(mask_asset) = settings.get_mut("maskImage").and_then(Value::as_object_mut) {
        persist_history_asset(mask_asset, &item_dir, "mask")?;
    }

    Ok(item)
}

fn persist_history_asset(
    asset: &mut Map<String, Value>,
    item_dir: &Path,
    file_base: &str,
) -> Result<(), String> {
    let Some(data_url) = asset.get("dataUrl").and_then(Value::as_str) else {
        return Ok(());
    };
    if data_url.is_empty() {
        return Ok(());
    }
    let mime_type = asset
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    let extension = extension_for_mime(mime_type);
    let path = item_dir.join(format!("{file_base}.{extension}"));
    let bytes = decode_data_url(data_url)?;
    fs::write(&path, bytes).map_err(|error| format!("履歴画像を保存できませんでした: {error}"))?;
    asset.insert(
        "path".to_string(),
        json!(path.to_string_lossy().to_string()),
    );
    Ok(())
}

fn extension_for_mime(mime_type: &str) -> &str {
    match mime_type {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    }
}

fn media_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "tif" | "tiff" => "image/tiff",
        _ => "image/png",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            load_runtime_config,
            load_locale,
            load_history,
            save_history,
            load_image_data_url,
            save_as_image,
            show_in_finder,
            copy_image_to_clipboard,
            open_external_url,
            generate_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
