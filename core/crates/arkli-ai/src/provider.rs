//! provider 探测与线程数策略。全是纯函数，输入由外部传入（不读系统状态）。
//!
//! 现状（spike B）：sherpa 自带的 ORT 只有 NNAPI 与 CPU，NNAPI 无加速且多占内存，
//! 所以默认等价于 CPU。

/// ORT 里 CPU provider 的名字。
pub const CPU_PROVIDER_NAME: &str = "CPUExecutionProvider";
/// ORT 里 NNAPI provider 的名字。
pub const NNAPI_PROVIDER_NAME: &str = "NnapiExecutionProvider";
/// 默认线程数。
pub const DEFAULT_THREADS: u32 = 4;
/// 低电量或后台时的线程数。
pub const REDUCED_THREADS: u32 = 2;

/// 选定的执行 provider。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// CPU（ORT 自带 MLAS），永远可用
    Cpu,
    /// Android NNAPI
    Nnapi,
}

/// provider 选择策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProviderPolicy {
    /// 是否允许使用 NNAPI。默认 false：实测无收益。
    pub allow_nnapi: bool,
}

/// 外部传入的设备状态，决定线程数。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PowerState {
    /// 是否低电量（或省电模式）
    pub low_battery: bool,
    /// 是否在后台运行
    pub background: bool,
}

/// 创建会话时用的选项。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionOptions {
    /// 执行 provider
    pub provider: Provider,
    /// 算子内线程数，至少为 1
    pub intra_threads: u32,
}

/// 按探测结果选 provider：列表里有 NNAPI 且策略允许才用，否则 CPU。
/// 即使列表里没有 CPU 也返回 CPU（ORT 保证 CPU 永远存在）。
///
/// ```
/// use arkli_ai::provider::*;
/// let list = vec![NNAPI_PROVIDER_NAME.to_string(), CPU_PROVIDER_NAME.to_string()];
/// assert_eq!(select_provider(&list, ProviderPolicy::default()), Provider::Cpu);
/// assert_eq!(select_provider(&list, ProviderPolicy { allow_nnapi: true }), Provider::Nnapi);
/// ```
pub fn select_provider<S: AsRef<str>>(available: &[S], policy: ProviderPolicy) -> Provider {
    let has_nnapi = available.iter().any(|n| n.as_ref() == NNAPI_PROVIDER_NAME);
    if policy.allow_nnapi && has_nnapi {
        Provider::Nnapi
    } else {
        Provider::Cpu
    }
}

/// 决定线程数：默认 4，低电量或后台降到 2，再不超过核心数，最少 1。
///
/// - `power`：设备状态
/// - `cores`：可用核心数（外部传入；0 视为未知，不限制）
///
/// ```
/// use arkli_ai::provider::*;
/// assert_eq!(pick_threads(PowerState::default(), 8), 4);
/// assert_eq!(pick_threads(PowerState { background: true, ..Default::default() }, 8), 2);
/// assert_eq!(pick_threads(PowerState::default(), 2), 2);
/// ```
pub fn pick_threads(power: PowerState, cores: u32) -> u32 {
    let base = if power.low_battery || power.background {
        REDUCED_THREADS
    } else {
        DEFAULT_THREADS
    };
    let capped = if cores == 0 { base } else { base.min(cores) };
    capped.max(1)
}

/// 一步得出会话选项：探测列表 + 策略 + 设备状态 -> [`SessionOptions`]。
pub fn resolve_options<S: AsRef<str>>(
    available: &[S],
    policy: ProviderPolicy,
    power: PowerState,
    cores: u32,
) -> SessionOptions {
    SessionOptions {
        provider: select_provider(available, policy),
        intra_threads: pick_threads(power, cores),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn provider选择矩阵() {
        let cpu = names(&[CPU_PROVIDER_NAME]);
        let both = names(&[NNAPI_PROVIDER_NAME, CPU_PROVIDER_NAME]);
        let empty: Vec<String> = vec![];
        let deny = ProviderPolicy { allow_nnapi: false };
        let allow = ProviderPolicy { allow_nnapi: true };
        assert_eq!(select_provider(&cpu, deny), Provider::Cpu);
        assert_eq!(select_provider(&cpu, allow), Provider::Cpu);
        assert_eq!(select_provider(&both, deny), Provider::Cpu);
        assert_eq!(select_provider(&both, allow), Provider::Nnapi);
        assert_eq!(select_provider(&empty, allow), Provider::Cpu);
    }

    #[test]
    fn 线程数矩阵() {
        let p = |low, bg| PowerState {
            low_battery: low,
            background: bg,
        };
        assert_eq!(pick_threads(p(false, false), 8), 4);
        assert_eq!(pick_threads(p(true, false), 8), 2);
        assert_eq!(pick_threads(p(false, true), 8), 2);
        assert_eq!(pick_threads(p(true, true), 8), 2);
        assert_eq!(pick_threads(p(false, false), 0), 4);
        assert_eq!(pick_threads(p(false, false), 3), 3);
        assert_eq!(pick_threads(p(true, false), 1), 1);
    }

    #[test]
    fn 一步得出选项() {
        let o = resolve_options(
            &[NNAPI_PROVIDER_NAME],
            ProviderPolicy::default(),
            PowerState {
                low_battery: true,
                background: false,
            },
            8,
        );
        assert_eq!(
            o,
            SessionOptions {
                provider: Provider::Cpu,
                intra_threads: 2
            }
        );
    }
}
