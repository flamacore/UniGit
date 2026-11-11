//! Reads Unity shader sources (ShaderLab and Shader Graph) far enough to know which material
//! properties a shader declares and how its surface is meant to be drawn. Shader code itself is
//! never executed: anything that only custom vertex/fragment code can express is reported in
//! `skipped` so the preview can tell the user what it left out.

use regex::Regex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShaderPropertyKind {
    Color,
    Vector,
    Float,
    Range,
    Int,
    Texture,
    Other,
}

#[derive(Debug, Clone)]
pub struct ShaderProperty {
    pub name: String,
    pub display_name: String,
    pub kind: ShaderPropertyKind,
    /// Lower-cased attribute names without arguments: `hdr`, `normal`, `maintexture`, ...
    pub attributes: Vec<String>,
    /// Raw default as written: `(1,1,1,1)`, `0.5`, `white`.
    pub default_value: String,
}

impl ShaderProperty {
    pub fn has_attribute(&self, name: &str) -> bool {
        self.attributes.iter().any(|attribute| attribute == name)
    }
}

#[derive(Debug, Clone, Default)]
pub struct ParsedShader {
    pub name: String,
    pub source_kind: &'static str,
    pub properties: Vec<ShaderProperty>,
    pub render_type: Option<String>,
    pub queue: Option<String>,
    pub render_pipeline: Option<String>,
    /// First `Blend` command, e.g. `SrcAlpha OneMinusSrcAlpha` or `[_SrcBlend] [_DstBlend]`.
    pub blend: Option<String>,
    /// First `Cull` command, e.g. `Off` or `[_Cull]`.
    pub cull: Option<String>,
    pub lit: bool,
    /// Emission is gated behind the `_EMISSION` keyword (Standard / URP Lit convention).
    pub emission_keyword: bool,
    pub pass_count: usize,
    pub skipped: Vec<String>,
}

pub fn parse_shader(file_name: &str, source: &str) -> Option<ParsedShader> {
    if file_name.to_ascii_lowercase().ends_with(".shadergraph") {
        parse_shader_graph(file_name, source)
    } else {
        parse_shaderlab(source)
    }
}

fn strip_comments(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut in_string = false;

    while let Some(ch) = chars.next() {
        if in_string {
            output.push(ch);
            if ch == '\\' {
                if let Some(next) = chars.next() {
                    output.push(next);
                }
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match (ch, chars.peek().copied()) {
            ('"', _) => {
                in_string = true;
                output.push(ch);
            }
            ('/', Some('/')) => {
                for skipped in chars.by_ref() {
                    if skipped == '\n' {
                        output.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut previous = ' ';
                for skipped in chars.by_ref() {
                    if previous == '*' && skipped == '/' {
                        break;
                    }
                    previous = skipped;
                }
                output.push(' ');
            }
            _ => output.push(ch),
        }
    }

    output
}

/// Returns the text between the brace that follows `keyword` and its matching close brace.
fn braced_block<'a>(source: &'a str, keyword: &str) -> Option<&'a str> {
    let pattern = Regex::new(&format!(r"\b{keyword}\s*\{{")).ok()?;
    let start = pattern.find(source)?.end();
    let mut depth = 1usize;

    for (offset, ch) in source[start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&source[start..start + offset]);
                }
            }
            _ => {}
        }
    }

    None
}

fn parse_shaderlab(source: &str) -> Option<ParsedShader> {
    let text = strip_comments(source);
    let name = Regex::new(r#"\bShader\s+"([^"]+)""#).ok()?.captures(&text)?[1].to_string();

    let mut shader = ParsedShader {
        name,
        source_kind: "ShaderLab",
        ..ParsedShader::default()
    };

    if let Some(block) = braced_block(&text, "Properties") {
        let property = Regex::new(
            r#"(?s)((?:\[[^\]]*\]\s*)*)([A-Za-z_]\w*)\s*\(\s*"([^"]*)"\s*,\s*([A-Za-z0-9]+)\s*(?:\([^)]*\))?\s*\)\s*=\s*(\([^)]*\)|"[^"]*"|[-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?)"#,
        )
        .ok()?;
        let attribute = Regex::new(r"\[\s*([A-Za-z_]\w*)").ok()?;

        for captures in property.captures_iter(block) {
            let kind = match captures[4].to_ascii_lowercase().as_str() {
                "color" => ShaderPropertyKind::Color,
                "vector" => ShaderPropertyKind::Vector,
                "float" => ShaderPropertyKind::Float,
                "range" => ShaderPropertyKind::Range,
                "int" | "integer" => ShaderPropertyKind::Int,
                "2d" | "3d" | "cube" | "cubearray" | "2darray" | "rect" | "any" => ShaderPropertyKind::Texture,
                _ => ShaderPropertyKind::Other,
            };

            shader.properties.push(ShaderProperty {
                name: captures[2].to_string(),
                display_name: captures[3].to_string(),
                kind,
                attributes: attribute
                    .captures_iter(&captures[1])
                    .map(|found| found[1].to_ascii_lowercase())
                    .collect(),
                default_value: captures[5].trim_matches('"').to_string(),
            });
        }
    }

    // Render state lives in ShaderLab, not inside the HLSL/CG program blocks.
    let state_text = Regex::new(r"(?s)\b(?:CGPROGRAM|HLSLPROGRAM|CGINCLUDE|HLSLINCLUDE)\b.*?\b(?:ENDCG|ENDHLSL)\b")
        .ok()?
        .replace_all(&text, " ")
        .to_string();

    let tag = Regex::new(r#""(RenderType|Queue|RenderPipeline)"\s*=\s*"([^"]*)""#).ok()?;
    for captures in tag.captures_iter(&state_text) {
        let slot = match &captures[1] {
            "RenderType" => &mut shader.render_type,
            "Queue" => &mut shader.queue,
            _ => &mut shader.render_pipeline,
        };
        if slot.is_none() {
            *slot = Some(captures[2].to_string());
        }
    }

    let operand = r"(?:\[\w+\]|\w+)";
    shader.blend = Regex::new(&format!(r"\bBlend\s+({operand}\s+{operand})"))
        .ok()?
        .captures(&state_text)
        .map(|captures| captures[1].split_whitespace().collect::<Vec<_>>().join(" "));
    shader.cull = Regex::new(&format!(r"\bCull\s+({operand})"))
        .ok()?
        .captures(&state_text)
        .map(|captures| captures[1].to_string());
    shader.pass_count = Regex::new(r"\bPass\s*\{").ok()?.find_iter(&state_text).count();

    let surface_shader = Regex::new(r"#pragma\s+surface\s+\w+\s+(\w+)").ok()?.captures(&text);
    let lighting_markers = [
        "UniversalFragmentPBR",
        "UniversalFragmentBlinnPhong",
        "LitForwardPass",
        "SimpleLitForwardPass",
        "UnityStandardCore",
        "UnityPBSLighting",
        "UNITY_BRDF_PBS",
        "_LightColor0",
        "_WorldSpaceLightPos0",
        "GetMainLight",
        "AutoLight.cginc",
        "ShaderPassForward.hlsl",
    ];
    shader.lit = surface_shader.is_some() || lighting_markers.iter().any(|marker| text.contains(marker));
    shader.emission_keyword = text.contains("_EMISSION");

    let has_program = text.contains("CGPROGRAM") || text.contains("HLSLPROGRAM");
    let mut skip = |condition: bool, note: &str| {
        if condition {
            shader.skipped.push(note.to_string());
        }
    };
    skip(
        has_program,
        "Custom vertex/fragment code is not executed; the preview maps the declared properties onto a standard surface.",
    );
    skip(text.contains("GrabPass"), "GrabPass (screen grab / refraction) is not simulated.");
    skip(
        Regex::new(r"#pragma\s+(geometry|hull|domain|tessellate)").ok()?.is_match(&text),
        "Geometry and tessellation stages are skipped.",
    );
    skip(shader.pass_count > 1 && surface_shader.is_none(), "Only the main pass is approximated; extra passes (outline, shadow, depth) are skipped.");
    skip(text.contains("_Time") || text.contains("_SinTime"), "Time-driven animation is shown as a still frame.");
    skip(Regex::new(r"\bStencil\s*\{").ok()?.is_match(&state_text), "Stencil rules are ignored.");

    Some(shader)
}

fn parse_shader_graph(file_name: &str, source: &str) -> Option<ParsedShader> {
    // A .shadergraph file is a stream of JSON objects, one per graph element.
    let objects = serde_json::Deserializer::from_str(source)
        .into_iter::<serde_json::Value>()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    if objects.is_empty() {
        return None;
    }

    let stem = file_name.rsplit('/').next().unwrap_or(file_name);
    let stem = stem.strip_suffix(".shadergraph").unwrap_or(stem);
    let mut shader = ParsedShader {
        name: format!("Shader Graphs/{stem}"),
        source_kind: "Shader Graph",
        ..ParsedShader::default()
    };
    let text = |value: &serde_json::Value, key: &str| {
        value.get(key).and_then(|field| field.as_str()).map(ToString::to_string).filter(|field| !field.is_empty())
    };
    let number = |value: &serde_json::Value, key: &str| value.get(key).and_then(|field| field.as_f64());
    let flag = |value: &serde_json::Value, key: &str| value.get(key).and_then(|field| field.as_bool()).unwrap_or(false);

    let mut transparent = false;
    let mut alpha_mode = 0.0;
    let mut two_sided = false;
    let mut alpha_clip = false;

    for object in &objects {
        let Some(type_name) = text(object, "m_Type") else {
            continue;
        };
        let short_type = type_name.rsplit('.').next().unwrap_or(&type_name);

        if let Some(path) = text(object, "m_Path") {
            if short_type == "GraphData" {
                shader.name = format!("{path}/{stem}");
            }
        }

        if let Some(kind_name) = short_type.strip_suffix("ShaderProperty") {
            let kind = match kind_name {
                "Color" => ShaderPropertyKind::Color,
                "Vector1" | "Float" | "Boolean" => ShaderPropertyKind::Float,
                "Vector2" | "Vector3" | "Vector4" => ShaderPropertyKind::Vector,
                "Texture2D" | "Texture2DArray" | "Texture3D" | "Cubemap" => ShaderPropertyKind::Texture,
                _ => ShaderPropertyKind::Other,
            };
            let display_name = text(object, "m_Name").unwrap_or_default();
            let name = text(object, "m_OverrideReferenceName")
                .or_else(|| text(object, "m_DefaultReferenceName"))
                .unwrap_or_else(|| display_name.clone());
            let default_value = match object.get("m_Value") {
                Some(value) if value.is_number() || value.is_boolean() => value.to_string(),
                Some(value) if value.get("r").is_some() => format!(
                    "({},{},{},{})",
                    number(value, "r").unwrap_or(0.0),
                    number(value, "g").unwrap_or(0.0),
                    number(value, "b").unwrap_or(0.0),
                    number(value, "a").unwrap_or(1.0)
                ),
                Some(value) if value.get("x").is_some() => format!(
                    "({},{},{},{})",
                    number(value, "x").unwrap_or(0.0),
                    number(value, "y").unwrap_or(0.0),
                    number(value, "z").unwrap_or(0.0),
                    number(value, "w").unwrap_or(0.0)
                ),
                _ => String::new(),
            };
            let mut attributes = Vec::new();
            if number(object, "m_ColorMode") == Some(1.0) {
                attributes.push("hdr".to_string());
            }
            if flag(object, "m_Hidden") || !flag(object, "m_GeneratePropertyBlock") && object.get("m_GeneratePropertyBlock").is_some() {
                attributes.push("hideininspector".to_string());
            }

            shader.properties.push(ShaderProperty {
                name,
                display_name,
                kind,
                attributes,
                default_value,
            });
        }

        if short_type.ends_with("SubTarget") {
            shader.lit |= short_type.contains("Lit") && !short_type.contains("Unlit");
        }
        if short_type.ends_with("Target") && !short_type.ends_with("SubTarget") {
            transparent |= number(object, "m_SurfaceType") == Some(1.0);
            alpha_mode = number(object, "m_AlphaMode").unwrap_or(alpha_mode);
            two_sided |= flag(object, "m_TwoSided") || number(object, "m_RenderFace") == Some(0.0);
            alpha_clip |= flag(object, "m_AlphaClip");
            shader.render_pipeline = Some(short_type.trim_end_matches("Target").to_string());
        }
    }

    shader.render_type = Some(if transparent { "Transparent" } else if alpha_clip { "TransparentCutout" } else { "Opaque" }.to_string());
    shader.blend = transparent.then(|| {
        match alpha_mode as i32 {
            1 => "One OneMinusSrcAlpha",
            2 => "One One",
            3 => "DstColor Zero",
            _ => "SrcAlpha OneMinusSrcAlpha",
        }
        .to_string()
    });
    shader.cull = two_sided.then(|| "Off".to_string());
    shader.pass_count = 1;
    shader.skipped.push(
        "The node graph is not evaluated; exposed properties are mapped by name onto a standard surface.".to_string(),
    );

    Some(shader)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHADERLAB: &str = r#"
// A typical hand-written toon shader.
Shader "Game/Toon Water"
{
    Properties
    {
        [MainTexture] _BaseTex ("Albedo (RGB)", 2D) = "white" {}
        [MainColor][HDR] _Tint ("Tint", Color) = (0.2, 0.5, 1, 0.8)
        [Normal] [NoScaleOffset] _Waves ("Wave Normals", 2D) = "bump" {}
        _Gloss ("Smoothness", Range(0, 1)) = 0.75
        [HideInInspector] _Cull ("Cull", Float) = 2
        // _Old ("Commented out", Float) = 1
        _Speed ("Scroll /* not a comment */ Speed", Vector) = (1, 0, 0, 0)
    }
    SubShader
    {
        Tags { "RenderType"="Transparent" "Queue"="Transparent" "RenderPipeline"="UniversalPipeline" }
        Blend SrcAlpha OneMinusSrcAlpha
        Cull [_Cull]
        GrabPass { "_Grab" }
        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            float Blend_Not_State;
            half4 frag() : SV_Target { Light l = GetMainLight(); return _Tint * _Time.y; }
            ENDHLSL
        }
        Pass { Name "Outline" Cull Front }
    }
}
"#;

    #[test]
    fn reads_shaderlab_properties_and_render_state() {
        let shader = parse_shader("Water.shader", SHADERLAB).expect("shader should parse");

        assert_eq!(shader.name, "Game/Toon Water");
        let names = shader.properties.iter().map(|property| property.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["_BaseTex", "_Tint", "_Waves", "_Gloss", "_Cull", "_Speed"]);

        let tint = &shader.properties[1];
        assert_eq!(tint.kind, ShaderPropertyKind::Color);
        assert!(tint.has_attribute("hdr") && tint.has_attribute("maincolor"));
        assert_eq!(tint.default_value, "(0.2, 0.5, 1, 0.8)");
        assert_eq!(shader.properties[0].default_value, "white");
        assert!(shader.properties[2].has_attribute("normal"));
        assert_eq!(shader.properties[3].kind, ShaderPropertyKind::Range);
        assert_eq!(shader.properties[5].display_name, "Scroll /* not a comment */ Speed");

        assert_eq!(shader.render_type.as_deref(), Some("Transparent"));
        assert_eq!(shader.blend.as_deref(), Some("SrcAlpha OneMinusSrcAlpha"));
        assert_eq!(shader.cull.as_deref(), Some("[_Cull]"));
        assert_eq!(shader.pass_count, 2);
        assert!(shader.lit);
        assert!(shader.skipped.iter().any(|note| note.contains("GrabPass")));
        assert!(shader.skipped.iter().any(|note| note.contains("Time-driven")));
    }

    #[test]
    fn reads_shader_graph_properties_and_target() {
        let graph = r#"{
    "m_SGVersion": 3,
    "m_Type": "UnityEditor.ShaderGraph.GraphData",
    "m_Path": "Shader Graphs"
}

{
    "m_Type": "UnityEditor.ShaderGraph.Internal.ColorShaderProperty",
    "m_Name": "Glow Color",
    "m_DefaultReferenceName": "_Glow_Color",
    "m_OverrideReferenceName": "_EmissionColor",
    "m_GeneratePropertyBlock": true,
    "m_Value": { "r": 1.0, "g": 0.5, "b": 0.0, "a": 1.0 },
    "m_ColorMode": 1
}

{
    "m_Type": "UnityEditor.ShaderGraph.Internal.Texture2DShaderProperty",
    "m_Name": "Main Tex",
    "m_DefaultReferenceName": "_Main_Tex",
    "m_OverrideReferenceName": "",
    "m_GeneratePropertyBlock": true
}

{
    "m_Type": "UnityEditor.Rendering.Universal.ShaderGraph.UniversalTarget",
    "m_SurfaceType": 1,
    "m_AlphaMode": 2,
    "m_RenderFace": 0
}

{
    "m_Type": "UnityEditor.Rendering.Universal.ShaderGraph.UniversalUnlitSubTarget"
}"#;

        let shader = parse_shader("Assets/Shaders/Glow.shadergraph", graph).expect("graph should parse");
        assert_eq!(shader.name, "Shader Graphs/Glow");
        assert_eq!(shader.source_kind, "Shader Graph");
        assert!(!shader.lit);
        assert_eq!(shader.properties.len(), 2);
        assert_eq!(shader.properties[0].name, "_EmissionColor");
        assert!(shader.properties[0].has_attribute("hdr"));
        assert_eq!(shader.properties[0].default_value, "(1,0.5,0,1)");
        assert_eq!(shader.properties[1].name, "_Main_Tex");
        assert_eq!(shader.blend.as_deref(), Some("One One"));
        assert_eq!(shader.cull.as_deref(), Some("Off"));
    }
}
