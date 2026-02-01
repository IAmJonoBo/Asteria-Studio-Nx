//! Pipeline core stub for Asteria Studio.
//! Deterministic CV primitives for future N-API integration.

pub fn process_page_stub(page_id: &str) -> String {
    format!("Processing not yet implemented for {page_id}")
}

/// Compute horizontal projection profile (sum of pixels per row).
pub fn projection_profile_y(data: &[u8], width: usize, height: usize) -> Vec<u32> {
    let mut rows = vec![0u32; height];
    for y in 0..height {
        let mut sum = 0u32;
        let offset = y * width;
        for x in 0..width {
            sum += data[offset + x] as u32;
        }
        rows[y] = sum;
    }
    rows
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_runs() {
        assert!(process_page_stub("demo").contains("demo"));
    }

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
}
