//! Pipeline core stub for Asteria Studio.
//! Deterministic CV primitives for N-API integration.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Compute horizontal projection profile (sum of pixels per row).
pub fn projection_profile_y(data: &[u8], width: usize, height: usize) -> Vec<u32> {
    let mut rows = vec![0u32; height];
    for (y, row) in rows.iter_mut().enumerate() {
        let mut sum = 0u32;
        let offset = y * width;
        for x in 0..width {
            sum += data[offset + x] as u32;
        }
        *row = sum;
    }
    rows
}

#[napi(js_name = "projectionProfileY")]
pub fn projection_profile_y_js(data: Buffer, width: u32, height: u32) -> Vec<u32> {
    let width = width as usize;
    let height = height as usize;
    let bytes = data.as_ref();
    if width == 0 || height == 0 || bytes.len() < width * height {
        return vec![];
    }
    projection_profile_y(&bytes[..width * height], width, height)
}

/// Compute vertical projection profile (sum of pixels per column).
pub fn projection_profile_x(data: &[u8], width: usize, height: usize) -> Vec<u32> {
    let mut cols = vec![0u32; width];
    for y in 0..height {
        let offset = y * width;
        for x in 0..width {
            cols[x] += data[offset + x] as u32;
        }
    }
    cols
}

#[napi(js_name = "projectionProfileX")]
pub fn projection_profile_x_js(data: Buffer, width: u32, height: u32) -> Vec<u32> {
    let width = width as usize;
    let height = height as usize;
    let bytes = data.as_ref();
    if width == 0 || height == 0 || bytes.len() < width * height {
        return vec![];
    }
    projection_profile_x(&bytes[..width * height], width, height)
}

/// Compute Sobel edge magnitude (grayscale) returning u16 values.
pub fn sobel_magnitude(data: &[u8], width: usize, height: usize) -> Vec<u16> {
    if width < 3 || height < 3 {
        return vec![0u16; width * height];
    }
    let mut out = vec![0u16; width * height];
    let gx = [-1i32, 0, 1, -2, 0, 2, -1, 0, 1];
    let gy = [1i32, 2, 1, 0, 0, 0, -1, -2, -1];

    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let mut sum_x = 0i32;
            let mut sum_y = 0i32;
            let mut k = 0usize;
            for ky in -1i32..=1 {
                for kx in -1i32..=1 {
                    let ix = (x as i32 + kx) as usize;
                    let iy = (y as i32 + ky) as usize;
                    let value = data[iy * width + ix] as i32;
                    sum_x += gx[k] * value;
                    sum_y += gy[k] * value;
                    k += 1;
                }
            }
            let magnitude = ((sum_x * sum_x + sum_y * sum_y) as f64).sqrt() as u16;
            out[y * width + x] = magnitude;
        }
    }
    out
}

#[napi(js_name = "sobelMagnitude")]
pub fn sobel_magnitude_js(data: Buffer, width: u32, height: u32) -> Vec<u16> {
    let width = width as usize;
    let height = height as usize;
    let bytes = data.as_ref();
    if width == 0 || height == 0 || bytes.len() < width * height {
        return vec![0u16; width.saturating_mul(height)];
    }
    sobel_magnitude(&bytes[..width * height], width, height)
}

#[napi(object)]
pub struct DeskewEstimate {
    pub angle: f64,
    pub confidence: f64,
}

#[napi(object)]
pub struct BaselineMetricsResult {
    #[napi(js_name = "lineConsistency")]
    pub line_consistency: f64,
    #[napi(js_name = "textLineCount")]
    pub text_line_count: u32,
    #[napi(js_name = "spacingNorm")]
    pub spacing_norm: f64,
    #[napi(js_name = "spacingMadNorm")]
    pub spacing_mad_norm: f64,
    #[napi(js_name = "offsetNorm")]
    pub offset_norm: f64,
    #[napi(js_name = "angleDeg")]
    pub angle_deg: f64,
    pub confidence: f64,
    #[napi(js_name = "peakSharpness")]
    pub peak_sharpness: f64,
    #[napi(js_name = "peaksY")]
    pub peaks_y: Vec<f64>,
}

#[napi(object)]
pub struct ColumnMetricsResult {
    #[napi(js_name = "columnCount")]
    pub column_count: u32,
    #[napi(js_name = "columnSeparation")]
    pub column_separation: f64,
}

#[napi(object)]
pub struct LayoutElementResult {
    pub id: String,
    #[napi(js_name = "type")]
    pub element_type: String,
    pub bbox: Vec<f64>,
    pub confidence: f64,
}

fn gradient_histogram(data: &[u8], width: usize, height: usize) -> [f64; 181] {
    let mut histogram = [0f64; 181];
    if width < 3 || height < 3 {
        return histogram;
    }
    let gx = [-1i32, 0, 1, -2, 0, 2, -1, 0, 1];
    let gy = [1i32, 2, 1, 0, 0, 0, -1, -2, -1];
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let mut sum_x = 0i32;
            let mut sum_y = 0i32;
            let mut k = 0usize;
            for ky in -1i32..=1 {
                for kx in -1i32..=1 {
                    let ix = (x as i32 + kx) as usize;
                    let iy = (y as i32 + ky) as usize;
                    let value = data[iy * width + ix] as i32;
                    sum_x += gx[k] * value;
                    sum_y += gy[k] * value;
                    k += 1;
                }
            }
            let magnitude = ((sum_x * sum_x + sum_y * sum_y) as f64).sqrt();
            if magnitude < 10.0 {
                continue;
            }
            let angle = (sum_y as f64).atan2(sum_x as f64).to_degrees();
            let bucket = (angle + 90.0).round().clamp(0.0, 180.0) as usize;
            histogram[bucket] += magnitude;
        }
    }
    histogram
}

#[napi(js_name = "estimateSkewAngle")]
pub fn estimate_skew_angle_js(data: Buffer, width: u32, height: u32) -> DeskewEstimate {
    let width = width as usize;
    let height = height as usize;
    let bytes = data.as_ref();
    if width == 0 || height == 0 || bytes.len() < width * height {
        return DeskewEstimate {
            angle: 0.0,
            confidence: 0.0,
        };
    }
    let histogram = gradient_histogram(&bytes[..width * height], width, height);
    let mut best_bucket = 90usize;
    let mut best_val = 0f64;
    for (idx, val) in histogram.iter().enumerate() {
        if *val > best_val {
            best_val = *val;
            best_bucket = idx;
        }
    }
    let window = 3i32;
    let mut num = 0f64;
    let mut den = 0f64;
    let start = (best_bucket as i32 - window).max(0) as usize;
    let end = (best_bucket as i32 + window).min(180) as usize;
    for (idx, w) in histogram.iter().enumerate().take(end + 1).skip(start) {
        num += (idx as f64 - 90.0) * w;
        den += *w;
    }
    let angle = if den > 0.0 { num / den } else { 0.0 };
    let confidence = (best_val / ((width * height) as f64 * 4.0)).min(1.0);
    DeskewEstimate { angle, confidence }
}

#[napi(js_name = "baselineMetrics")]
pub fn baseline_metrics_js(data: Buffer, width: u32, height: u32) -> BaselineMetricsResult {
    let width = width as usize;
    let height = height as usize;
    let bytes = data.as_ref();
    if width == 0 || height == 0 || bytes.len() < width * height {
        return BaselineMetricsResult {
            line_consistency: 0.0,
            text_line_count: 0,
            spacing_norm: 0.0,
            spacing_mad_norm: 0.0,
            offset_norm: 0.0,
            angle_deg: 0.0,
            confidence: 0.0,
            peak_sharpness: 0.0,
            peaks_y: Vec::new(),
        };
    }
    let mut row_sums = vec![0f64; height];
    for (y, row_sum) in row_sums.iter_mut().enumerate() {
        let offset = y * width;
        let mut sum = 0f64;
        for x in 0..width {
            sum += 255f64 - bytes[offset + x] as f64;
        }
        *row_sum = sum;
    }
    let mean = row_sums.iter().sum::<f64>() / (row_sums.len().max(1) as f64);
    let variance = row_sums
        .iter()
        .map(|v| (v - mean) * (v - mean))
        .sum::<f64>()
        / (row_sums.len().max(1) as f64);
    let std = variance.sqrt();
    let line_consistency = if mean > 0.0 {
        (1.0 - (std / (mean * 2.0)).min(1.0)).max(0.0)
    } else {
        0.0
    };
    let threshold = mean + std * 0.6;
    let mut peaks: Vec<usize> = Vec::new();
    let mut sharpness_sum = 0f64;
    let mut sharpness_count = 0f64;
    for y in 1..row_sums.len().saturating_sub(1) {
        if row_sums[y] > threshold && row_sums[y] > row_sums[y - 1] && row_sums[y] > row_sums[y + 1]
        {
            peaks.push(y);
            let neighbor_avg = 0.5 * (row_sums[y - 1] + row_sums[y + 1]);
            let sharpness = row_sums[y] - neighbor_avg;
            if std > 0.0 {
                sharpness_sum += sharpness / std;
                sharpness_count += 1.0;
            }
        }
    }
    let peak_sharpness = if sharpness_count > 0.0 {
        sharpness_sum / sharpness_count
    } else {
        0.0
    };

    let mut spacing_norm = 0.0;
    let mut spacing_mad_norm = 0.0;
    let mut offset_norm = 0.0;
    if peaks.len() > 1 && height > 1 {
        let mut deltas: Vec<f64> = peaks
            .windows(2)
            .map(|pair| (pair[1] as f64 - pair[0] as f64) / ((height - 1) as f64))
            .collect();
        deltas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        spacing_norm = if deltas.len() % 2 == 0 {
            let mid = deltas.len() / 2;
            (deltas[mid - 1] + deltas[mid]) / 2.0
        } else {
            deltas[deltas.len() / 2]
        };
        let mut mad_values: Vec<f64> = deltas.iter().map(|d| (d - spacing_norm).abs()).collect();
        mad_values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        spacing_mad_norm = if mad_values.is_empty() {
            0.0
        } else if mad_values.len() % 2 == 0 {
            let mid = mad_values.len() / 2;
            (mad_values[mid - 1] + mad_values[mid]) / 2.0
        } else {
            mad_values[mad_values.len() / 2]
        };
        if spacing_norm > 0.0 {
            let mut offsets: Vec<f64> = peaks
                .iter()
                .map(|y| (y % ((height - 1).max(1))) as f64 / ((height - 1) as f64))
                .map(|y_norm| y_norm % spacing_norm)
                .collect();
            offsets.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            offset_norm = if offsets.len() % 2 == 0 {
                let mid = offsets.len() / 2;
                (offsets[mid - 1] + offsets[mid]) / 2.0
            } else {
                offsets[offsets.len() / 2]
            };
        }
    }
    let peak_count_score = ((peaks.len() as f64 - 2.0) / 8.0).clamp(0.0, 1.0);
    let spacing_score = if spacing_norm > 0.0 {
        (1.0 - (spacing_mad_norm / spacing_norm).min(1.0)).max(0.0)
    } else {
        0.0
    };
    let sharpness_score = (peak_sharpness / 3.0).clamp(0.0, 1.0);
    let confidence = (0.4 * spacing_score + 0.35 * sharpness_score + 0.25 * peak_count_score)
        .clamp(0.0, 1.0);
    let peaks_y: Vec<f64> = if height > 1 {
        peaks.iter().map(|y| *y as f64 / ((height - 1) as f64)).collect()
    } else {
        Vec::new()
    };
    BaselineMetricsResult {
        line_consistency,
        text_line_count: peaks.len() as u32,
        spacing_norm,
        spacing_mad_norm,
        offset_norm,
        angle_deg: 0.0,
        confidence,
        peak_sharpness,
        peaks_y,
    }
}

#[napi(js_name = "columnMetrics")]
pub fn column_metrics_js(data: Buffer, width: u32, height: u32) -> ColumnMetricsResult {
    let width = width as usize;
    let height = height as usize;
    let bytes = data.as_ref();
    if width == 0 || height == 0 || bytes.len() < width * height {
        return ColumnMetricsResult {
            column_count: 0,
            column_separation: 0.0,
        };
    }
    let mut col_sums = vec![0f64; width];
    for x in 0..width {
        let mut sum = 0f64;
        for y in 0..height {
            sum += 255f64 - bytes[y * width + x] as f64;
        }
        col_sums[x] = sum;
    }
    let mean = col_sums.iter().sum::<f64>() / (col_sums.len().max(1) as f64);
    let variance = col_sums
        .iter()
        .map(|v| (v - mean) * (v - mean))
        .sum::<f64>()
        / (col_sums.len().max(1) as f64);
    let std = variance.sqrt();
    let threshold = mean + std * 0.7;
    let mut column_bands = 0u32;
    let mut in_band = false;
    for val in col_sums {
        if val > threshold {
            if !in_band {
                column_bands += 1;
                in_band = true;
            }
        } else {
            in_band = false;
        }
    }
    ColumnMetricsResult {
        column_count: column_bands.max(1),
        column_separation: std,
    }
}

fn compute_mean_std(data: &[u8]) -> (f64, f64) {
    if data.is_empty() {
        return (0.0, 0.0);
    }
    let sum: f64 = data.iter().map(|v| *v as f64).sum();
    let mean = sum / data.len() as f64;
    let variance = data
        .iter()
        .map(|v| {
            let dv = *v as f64 - mean;
            dv * dv
        })
        .sum::<f64>()
        / data.len() as f64;
    (mean, variance.sqrt())
}

#[napi(js_name = "detectLayoutElements")]
pub fn detect_layout_elements_js(
    data: Buffer,
    width: u32,
    height: u32,
) -> Vec<LayoutElementResult> {
    let width = width as usize;
    let height = height as usize;
    let bytes = data.as_ref();
    if width == 0 || height == 0 || bytes.len() < width * height {
        return vec![];
    }

    let (mean, std) = compute_mean_std(&bytes[..width * height]);
    let threshold = (mean - std * 0.5).clamp(10.0, 245.0);

    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    let mut found = false;

    for y in 0..height {
        let offset = y * width;
        for x in 0..width {
            if (bytes[offset + x] as f64) < threshold {
                found = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }

    let (x0, y0, x1, y1) = if found {
        (min_x as f64, min_y as f64, max_x as f64, max_y as f64)
    } else {
        (0.0, 0.0, (width - 1) as f64, (height - 1) as f64)
    };

    let content_width = (x1 - x0).max(1.0);
    let content_height = (y1 - y0).max(1.0);
    let make_box = |fx0: f64, fy0: f64, fx1: f64, fy1: f64| -> Vec<f64> {
        vec![
            (x0 + content_width * fx0).clamp(0.0, (width - 1) as f64),
            (y0 + content_height * fy0).clamp(0.0, (height - 1) as f64),
            (x0 + content_width * fx1).clamp(0.0, (width - 1) as f64),
            (y0 + content_height * fy1).clamp(0.0, (height - 1) as f64),
        ]
    };

    vec![
        LayoutElementResult {
            id: "page-bounds".to_string(),
            element_type: "page_bounds".to_string(),
            bbox: vec![0.0, 0.0, (width - 1) as f64, (height - 1) as f64],
            confidence: 0.6,
        },
        LayoutElementResult {
            id: "text-block".to_string(),
            element_type: "text_block".to_string(),
            bbox: vec![x0, y0, x1, y1],
            confidence: 0.55,
        },
        LayoutElementResult {
            id: "title".to_string(),
            element_type: "title".to_string(),
            bbox: make_box(0.12, 0.02, 0.88, 0.14),
            confidence: 0.28,
        },
        LayoutElementResult {
            id: "running-head".to_string(),
            element_type: "running_head".to_string(),
            bbox: make_box(0.1, 0.0, 0.9, 0.08),
            confidence: 0.25,
        },
        LayoutElementResult {
            id: "folio".to_string(),
            element_type: "folio".to_string(),
            bbox: make_box(0.42, 0.9, 0.58, 0.98),
            confidence: 0.22,
        },
        LayoutElementResult {
            id: "ornament".to_string(),
            element_type: "ornament".to_string(),
            bbox: make_box(0.42, 0.18, 0.58, 0.24),
            confidence: 0.2,
        },
        LayoutElementResult {
            id: "drop-cap".to_string(),
            element_type: "drop_cap".to_string(),
            bbox: make_box(0.02, 0.18, 0.1, 0.32),
            confidence: 0.18,
        },
        LayoutElementResult {
            id: "footnote".to_string(),
            element_type: "footnote".to_string(),
            bbox: make_box(0.05, 0.86, 0.95, 0.98),
            confidence: 0.2,
        },
        LayoutElementResult {
            id: "marginalia".to_string(),
            element_type: "marginalia".to_string(),
            bbox: make_box(0.0, 0.25, 0.08, 0.75),
            confidence: 0.18,
        },
    ]
}

/// Compute a 9x8 dHash from a downsampled 9x8 grayscale image.
pub fn dhash_9x8(data: &[u8]) -> u64 {
    if data.len() != 9 * 8 {
        return 0;
    }
    let mut hash = 0u64;
    let mut bit = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            let left = data[y * 9 + x];
            let right = data[y * 9 + x + 1];
            if left < right {
                hash |= 1u64 << bit;
            }
            bit += 1;
        }
    }
    hash
}

#[napi(js_name = "dhash9x8")]
pub fn dhash_9x8_js(data: Buffer) -> String {
    let bytes = data.as_ref();
    if bytes.len() < 9 * 8 {
        return "0".to_string();
    }
    let hash = dhash_9x8(&bytes[..9 * 8]);
    format!("{:016x}", hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_profiles_have_expected_lengths() {
        let data = vec![10u8; 16];
        let rows = projection_profile_y(&data, 4, 4);
        let cols = projection_profile_x(&data, 4, 4);
        assert_eq!(rows.len(), 4);
        assert_eq!(cols.len(), 4);
        assert_eq!(rows[0], 40);
        assert_eq!(cols[0], 40);
    }

    #[test]
    fn sobel_magnitude_is_deterministic() {
        let mut data = vec![0u8; 25];
        data[12] = 255;
        let out_a = sobel_magnitude(&data, 5, 5);
        let out_b = sobel_magnitude(&data, 5, 5);
        assert_eq!(out_a, out_b);
        assert_eq!(out_a.len(), 25);
    }

    #[test]
    fn dhash_outputs_nonzero_for_gradient() {
        let mut data = vec![0u8; 9 * 8];
        for y in 0..8 {
            for x in 0..9 {
                data[y * 9 + x] = (x * 16) as u8;
            }
        }
        let hash = dhash_9x8(&data);
        assert_ne!(hash, 0);
    }

    #[test]
    fn baseline_and_column_metrics_return_values() {
        let width = 8;
        let height = 8;
        let mut data = vec![255u8; width * height];
        for x in 0..width {
            data[2 * width + x] = 0;
            data[5 * width + x] = 0;
        }
        for y in 0..height {
            data[y * width + 3] = 0;
        }
        let baseline = baseline_metrics_js(Buffer::from(data.clone()), width as u32, height as u32);
        let columns = column_metrics_js(Buffer::from(data), width as u32, height as u32);
        assert!(baseline.line_consistency >= 0.0);
        assert!(baseline.text_line_count >= 1);
        assert!(columns.column_count >= 1);
        assert!(columns.column_separation >= 0.0);
    }

    #[test]
    fn detect_layout_elements_returns_content_boxes() {
        let width = 10;
        let height = 10;
        let mut data = vec![255u8; width * height];
        for y in 2..8 {
            for x in 3..7 {
                data[y * width + x] = 0;
            }
        }
        let elements = detect_layout_elements_js(Buffer::from(data), width as u32, height as u32);
        assert!(!elements.is_empty());
        assert!(elements.iter().any(|el| el.id == "page-bounds"));
    }
}
