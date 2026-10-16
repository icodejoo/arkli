//! 图外词嵌入表（MNN 翻译用）：逐行 int8 + 每行一个 float32 缩放，还原为 `e ≈ q × scale`。
//!
//! 文件布局（`scripts/mnn/nllb_embed.py` 导出，全部小端、无头部）：
//! - `embed.i8`：`int8[行数, 维度]`，行主序；
//! - `embed.scale`：`float32[行数]`。
//!
//! 行数 = `embed.scale` 字节数 / 4，维度 = `embed.i8` 字节数 / 行数。NLLB 词表 61796 行 × 1024 维约 63MB，
//! 加载后常驻内存（编码器与解码器共用这一张表）。

use std::path::Path;

use super::manifest::EMBED_SCALE_BYTES;

/// 已加载的嵌入表。
#[derive(Debug, Clone, PartialEq)]
pub struct EmbedTable {
    /// 行主序 int8 原始字节（按需 `as i8` 解读，避免再拷一份）。
    q: Vec<u8>,
    /// 每行缩放。
    scale: Vec<f32>,
    /// 嵌入维度。
    dim: usize,
}

impl EmbedTable {
    /// 由两段原始字节构造并校验。
    ///
    /// # 参数
    /// - `q`：`embed.i8` 全部内容。
    /// - `scale_bytes`：`embed.scale` 全部内容（小端 float32）。
    ///
    /// # 返回
    /// 嵌入表；缩放字节数不是 4 的倍数或为空、嵌入字节数不能被行数整除或为空、缩放含非有限值时返回错误说明。
    ///
    /// # 示例
    /// ```ignore
    /// let t = EmbedTable::from_bytes(vec![1, 2, 3, 4], &1.0f32.to_le_bytes().repeat(2))?;
    /// assert_eq!((t.rows(), t.dim()), (2, 2));
    /// ```
    pub fn from_bytes(q: Vec<u8>, scale_bytes: &[u8]) -> Result<Self, String> {
        let width = EMBED_SCALE_BYTES as usize;
        if scale_bytes.is_empty() || !scale_bytes.len().is_multiple_of(width) {
            return Err(format!(
                "embed scale size {} must be a non-zero multiple of {width}",
                scale_bytes.len()
            ));
        }
        let rows = scale_bytes.len() / width;
        if q.is_empty() || !q.len().is_multiple_of(rows) {
            return Err(format!(
                "embed table size {} is not a non-zero multiple of {rows} rows",
                q.len()
            ));
        }
        let scale: Vec<f32> = scale_bytes
            .chunks_exact(width)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        if let Some(i) = scale.iter().position(|s| !s.is_finite()) {
            return Err(format!("embed scale row {i} is not finite"));
        }
        let dim = q.len() / rows;
        Ok(Self { q, scale, dim })
    }

    /// 从两个文件加载。
    ///
    /// # 参数
    /// - `i8_path`：`embed.i8`。
    /// - `scale_path`：`embed.scale`。
    ///
    /// # 返回
    /// 嵌入表；读文件失败或内容不自洽返回错误说明。
    ///
    /// # 示例
    /// ```ignore
    /// let t = EmbedTable::load(&dir.join("embed.i8"), &dir.join("embed.scale"))?;
    /// ```
    pub fn load(i8_path: &Path, scale_path: &Path) -> Result<Self, String> {
        let read = |p: &Path| std::fs::read(p).map_err(|e| format!("read {}: {e}", p.display()));
        let scale = read(scale_path)?;
        let q = read(i8_path)?;
        Self::from_bytes(q, &scale)
    }

    /// 行数（= 词表大小）。
    pub fn rows(&self) -> usize {
        self.scale.len()
    }

    /// 嵌入维度。
    pub fn dim(&self) -> usize {
        self.dim
    }

    /// 查若干 token 的嵌入行，拼成 `[ids.len(), dim]` 的 f32（行主序）。
    ///
    /// # 参数
    /// - `ids`：token id；负数或 ≥ 行数视为越界。
    ///
    /// # 返回
    /// 展平的 f32 数据；越界返回错误说明。
    ///
    /// # 示例
    /// ```ignore
    /// let emb = table.lookup(&[2, 61795])?; // 长度 2 × dim
    /// ```
    pub fn lookup(&self, ids: &[i64]) -> Result<Vec<f32>, String> {
        let mut out = Vec::with_capacity(ids.len() * self.dim);
        for &id in ids {
            let row = usize::try_from(id)
                .ok()
                .filter(|&r| r < self.rows())
                .ok_or_else(|| format!("token id {id} out of embedding range 0..{}", self.rows()))?;
            let s = self.scale[row];
            let bytes = &self.q[row * self.dim..(row + 1) * self.dim];
            out.extend(bytes.iter().map(|&b| f32::from(b as i8) * s));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把 f32 列表编成小端字节。
    fn f32_bytes(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_le_bytes()).collect()
    }

    /// 两行三维：还原值 = q × 该行 scale，负数字节按 int8 解读。
    #[test]
    fn lookup_dequantizes_rows() {
        let q = vec![1u8, 2, 3, 0xFF, 0x80, 127]; // 行 1 = [-1, -128, 127]
        let t = EmbedTable::from_bytes(q, &f32_bytes(&[0.5, 2.0])).unwrap();
        assert_eq!((t.rows(), t.dim()), (2, 3));
        assert_eq!(t.lookup(&[0]).unwrap(), vec![0.5, 1.0, 1.5]);
        assert_eq!(t.lookup(&[1, 0]).unwrap(), vec![-2.0, -256.0, 254.0, 0.5, 1.0, 1.5]);
        assert!(t.lookup(&[]).unwrap().is_empty());
    }

    /// 越界（负数、等于行数）报错并带范围。
    #[test]
    fn lookup_rejects_out_of_range() {
        let t = EmbedTable::from_bytes(vec![0; 4], &f32_bytes(&[1.0, 1.0])).unwrap();
        for bad in [-1i64, 2, i64::MAX] {
            let e = t.lookup(&[0, bad]).unwrap_err();
            assert!(e.contains("out of embedding range"), "{e}");
        }
    }

    /// 自洽校验：scale 非 4 的倍数 / 为空、i8 不能被行数整除 / 为空、scale 含 NaN 都报错。
    #[test]
    fn from_bytes_validates_sizes() {
        assert!(EmbedTable::from_bytes(vec![0; 4], &[0u8; 6]).is_err());
        assert!(EmbedTable::from_bytes(vec![0; 4], &[]).is_err());
        assert!(EmbedTable::from_bytes(vec![0; 5], &f32_bytes(&[1.0, 1.0])).is_err());
        assert!(EmbedTable::from_bytes(vec![], &f32_bytes(&[1.0])).is_err());
        assert!(EmbedTable::from_bytes(vec![0; 2], &f32_bytes(&[1.0, f32::NAN])).is_err());
        assert!(EmbedTable::from_bytes(vec![0; 6], &f32_bytes(&[1.0, 1.0])).is_ok());
    }

    /// 文件加载：与 from_bytes 一致，缺文件报错。
    #[test]
    fn load_reads_files() {
        let dir = std::env::temp_dir().join(format!("arkli-embed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("e.i8"), [1u8, 2]).unwrap();
        std::fs::write(dir.join("e.scale"), f32_bytes(&[3.0])).unwrap();
        let t = EmbedTable::load(&dir.join("e.i8"), &dir.join("e.scale")).unwrap();
        assert_eq!(t.lookup(&[0]).unwrap(), vec![3.0, 6.0]);
        assert!(EmbedTable::load(&dir.join("none.i8"), &dir.join("e.scale")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
