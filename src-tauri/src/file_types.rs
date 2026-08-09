use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

const DOCUMENT_TYPE_POLICY_JSON: &str = include_str!("../../shared/document-types.json");

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackendError {
    pub code: &'static str,
    pub message: String,
}

impl BackendError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn policy_invalid(message: impl Into<String>) -> Self {
        Self::new("policy_invalid", message)
    }

    pub fn unsupported_type(path: &Path) -> Self {
        Self::new(
            "unsupported_type",
            format!("不支持的文档类型: {}", path.display()),
        )
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Markdown,
    Text,
    Log,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RenderMode {
    Markdown,
    Plain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocumentType {
    pub kind: DocumentKind,
    pub render_mode: RenderMode,
    pub editable: bool,
    pub warn_when_large: bool,
}

impl DocumentType {
    pub fn can_save(self) -> bool {
        self.editable
    }
}

#[derive(Debug, Clone)]
struct TypePolicy {
    document_type: DocumentType,
    extensions: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DocumentTypePolicy {
    large_log_warning_bytes: u64,
    types: [TypePolicy; 3],
}

impl DocumentTypePolicy {
    pub fn large_log_warning_bytes(&self) -> u64 {
        self.large_log_warning_bytes
    }

    fn classify_extension(&self, extension: &str) -> Option<DocumentType> {
        self.types
            .iter()
            .find(|policy| {
                policy
                    .extensions
                    .iter()
                    .any(|candidate| candidate == extension)
            })
            .map(|policy| policy.document_type)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPolicy {
    version: u64,
    large_log_warning_bytes: u64,
    types: RawTypes,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTypes {
    markdown: RawTypePolicy,
    text: RawTypePolicy,
    log: RawTypePolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawTypePolicy {
    extensions: Vec<String>,
    render_mode: RenderMode,
    editable: bool,
    toc: bool,
    warn_when_large: bool,
}

fn parse_policy(json: &str) -> Result<DocumentTypePolicy, BackendError> {
    let raw: RawPolicy = serde_json::from_str(json)
        .map_err(|error| BackendError::policy_invalid(format!("文档类型策略无法解析: {error}")))?;

    if raw.version != 1 {
        return Err(BackendError::policy_invalid("文档类型策略版本无效"));
    }
    if raw.large_log_warning_bytes == 0 || raw.large_log_warning_bytes > 9_007_199_254_740_991 {
        return Err(BackendError::policy_invalid("大日志阈值必须是正整数"));
    }

    let expected = [
        (
            DocumentKind::Markdown,
            RenderMode::Markdown,
            true,
            true,
            false,
            raw.types.markdown,
        ),
        (
            DocumentKind::Text,
            RenderMode::Plain,
            true,
            false,
            false,
            raw.types.text,
        ),
        (
            DocumentKind::Log,
            RenderMode::Plain,
            false,
            false,
            true,
            raw.types.log,
        ),
    ];

    let mut seen_extensions = HashSet::new();
    let mut validated_types = Vec::with_capacity(expected.len());
    for (kind, render_mode, editable, toc, warn_when_large, raw_type) in expected {
        if raw_type.render_mode != render_mode
            || raw_type.editable != editable
            || raw_type.toc != toc
            || raw_type.warn_when_large != warn_when_large
        {
            return Err(BackendError::policy_invalid(format!(
                "文档类型 {kind:?} 的能力配置无效"
            )));
        }
        if raw_type.extensions.is_empty() {
            return Err(BackendError::policy_invalid(format!(
                "文档类型 {kind:?} 缺少扩展名"
            )));
        }

        for extension in &raw_type.extensions {
            let valid = !extension.is_empty()
                && extension
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
            if !valid {
                return Err(BackendError::policy_invalid(format!(
                    "文档类型 {kind:?} 包含无效扩展名"
                )));
            }
            if !seen_extensions.insert(extension.clone()) {
                return Err(BackendError::policy_invalid(format!(
                    "扩展名 {extension} 重复"
                )));
            }
        }

        validated_types.push(TypePolicy {
            document_type: DocumentType {
                kind,
                render_mode,
                editable,
                warn_when_large,
            },
            extensions: raw_type.extensions,
        });
    }

    let types: [TypePolicy; 3] = validated_types
        .try_into()
        .map_err(|_| BackendError::policy_invalid("文档类型策略必须恰好包含三个类型分组"))?;

    Ok(DocumentTypePolicy {
        large_log_warning_bytes: raw.large_log_warning_bytes,
        types,
    })
}

static DOCUMENT_TYPE_POLICY: OnceLock<Result<DocumentTypePolicy, BackendError>> = OnceLock::new();

pub fn policy() -> Result<&'static DocumentTypePolicy, BackendError> {
    match DOCUMENT_TYPE_POLICY.get_or_init(|| parse_policy(DOCUMENT_TYPE_POLICY_JSON)) {
        Ok(policy) => Ok(policy),
        Err(error) => Err(error.clone()),
    }
}

fn extract_extension(path: &Path) -> Option<String> {
    let value = path.as_os_str().to_string_lossy();
    let last_segment = value.rsplit(['/', '\\']).next()?;
    let dot_index = last_segment.rfind('.')?;
    if dot_index == 0 || dot_index + 1 == last_segment.len() {
        return None;
    }
    Some(last_segment[dot_index + 1..].to_ascii_lowercase())
}

pub fn classify_path(path: &Path) -> Result<DocumentType, BackendError> {
    let policy = policy()?;
    let extension = extract_extension(path).ok_or_else(|| BackendError::unsupported_type(path))?;
    policy
        .classify_extension(&extension)
        .ok_or_else(|| BackendError::unsupported_type(path))
}

pub fn is_supported_document_path(path: &Path) -> bool {
    classify_path(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn embedded_policy_parses_and_classifies_all_document_kinds() {
        let parsed = parse_policy(DOCUMENT_TYPE_POLICY_JSON).expect("embedded policy should parse");
        assert_eq!(parsed.large_log_warning_bytes(), 10 * 1024 * 1024);

        assert_eq!(
            parsed.classify_extension("md").unwrap().kind,
            DocumentKind::Markdown
        );
        assert_eq!(
            (
                parsed.classify_extension("tex").unwrap().kind,
                parsed.classify_extension("tex").unwrap().can_save()
            ),
            (DocumentKind::Text, true)
        );
        assert_eq!(
            (
                parsed.classify_extension("log").unwrap().kind,
                parsed.classify_extension("log").unwrap().can_save()
            ),
            (DocumentKind::Log, false)
        );
    }

    #[test]
    fn paths_are_classified_case_insensitively_and_require_a_real_suffix() {
        assert_eq!(
            classify_path(Path::new("/notes/README.MarkDown"))
                .unwrap()
                .kind,
            DocumentKind::Markdown
        );
        assert_eq!(
            classify_path(Path::new(r"C:\notes\paper.TeX"))
                .unwrap()
                .kind,
            DocumentKind::Text
        );
        assert_eq!(
            classify_path(Path::new("/logs/build.LOG")).unwrap().kind,
            DocumentKind::Log
        );

        for path in [
            "",
            "/notes/no-extension",
            "/notes/trailing.",
            "/notes/.log",
            "/notes/image.png",
            "/notes/fake.log/",
        ] {
            let error = classify_path(Path::new(path)).unwrap_err();
            assert_eq!(error.code, "unsupported_type", "path: {path}");
        }
    }

    #[test]
    fn policy_validation_fails_closed_for_malformed_or_ambiguous_data() {
        let valid: serde_json::Value =
            serde_json::from_str(DOCUMENT_TYPE_POLICY_JSON).expect("fixture should parse");

        let mut invalid_policies = Vec::new();

        let mut wrong_version = valid.clone();
        wrong_version["version"] = json!(2);
        invalid_policies.push(wrong_version);

        let mut zero_threshold = valid.clone();
        zero_threshold["largeLogWarningBytes"] = json!(0);
        invalid_policies.push(zero_threshold);

        let mut unsafe_integer_threshold = valid.clone();
        unsafe_integer_threshold["largeLogWarningBytes"] = json!(9_007_199_254_740_992_u64);
        invalid_policies.push(unsafe_integer_threshold);

        let mut duplicate_extension = valid.clone();
        duplicate_extension["types"]["text"]["extensions"] = json!(["txt", "md"]);
        invalid_policies.push(duplicate_extension);

        let mut invalid_extension = valid.clone();
        invalid_extension["types"]["text"]["extensions"] = json!(["TXT"]);
        invalid_policies.push(invalid_extension);

        let mut unsafe_log = valid.clone();
        unsafe_log["types"]["log"]["editable"] = json!(true);
        invalid_policies.push(unsafe_log);

        let mut unknown_field = valid.clone();
        unknown_field["allowAnyFile"] = json!(true);
        invalid_policies.push(unknown_field);

        let mut unknown_type_field = valid.clone();
        unknown_type_field["types"]["text"]["allowAnyFile"] = json!(true);
        invalid_policies.push(unknown_type_field);

        let mut missing_type_field = valid.clone();
        missing_type_field["types"]["text"]
            .as_object_mut()
            .unwrap()
            .remove("toc");
        invalid_policies.push(missing_type_field);

        let mut extra_group = valid.clone();
        extra_group["types"]["binary"] = valid["types"]["text"].clone();
        invalid_policies.push(extra_group);

        let mut missing_group = valid;
        missing_group["types"]
            .as_object_mut()
            .unwrap()
            .remove("log");
        invalid_policies.push(missing_group);

        for invalid in invalid_policies {
            let error = parse_policy(&invalid.to_string()).unwrap_err();
            assert_eq!(error.code, "policy_invalid");
        }
    }

    #[test]
    fn backend_errors_serialize_as_structured_values_with_stable_codes() {
        let error = BackendError::unsupported_type(Path::new("image.png"));
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["code"], "unsupported_type");
        assert!(serialized["message"]
            .as_str()
            .unwrap()
            .contains("image.png"));
    }
}
