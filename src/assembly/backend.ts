import { displayAllFeatures } from '@/store/settings'
import { activeBackend } from '@/store/setup'
import { computed, ref } from 'vue'

// usbip 需要 sing-box gRPC API v2(ProvideUSBDevices 流)
const USBIP_MIN_API_VERSION = 2
// OpenVPN 需要 sing-box gRPC API v3(SubscribeOpenVPNStatus 流)
const OPENVPN_MIN_API_VERSION = 3
// Taildrop 需要 sing-box gRPC API v4(SubscribeTaildropInbox / SendTaildropFiles 等)
const TAILDROP_MIN_API_VERSION = 4

export enum Channel {
  Clash = 'clash',
  Singbox = 'singbox',
}

export enum Core {
  Mihomo = 'mihomo',
  Singbox = 'singbox',
  Honk = 'honk',
  Unknown = 'unknown',
}

export const channel = computed<Channel>(() =>
  activeBackend.value?.type === 'singbox' ? Channel.Singbox : Channel.Clash,
)

// core / apiVersion 由 assembly/version.ts 在探测 /version 后写入,
// 后端切换时先重置为未知,避免沿用上一个后端的结论。
export const core = ref<Core>(Core.Unknown)
export const apiVersion = ref(0)

export const resetCore = () => {
  core.value = Core.Unknown
  apiVersion.value = 0
}

// displayAllFeatures 的适用范围:Clash 通道上跑着非 mihomo 内核(sing-box / honk)时。
// 该开关的语义是「我用的 fork 版内核也支持这些 mihomo 扩展端点,先显示出来」——
// 只有在 Clash 通道上,那些端点才有可能存在。sing-box API(gRPC)通道上它们压根不是
// 同一套协议,掰开只会打出必然失败的请求,所以那里既不显示开关,存量的 true 也不生效。
// core 未探测出结论(Unknown)时不掰,免得凭空点亮一堆按钮。
const isNonMihomoClashCore = computed(
  () =>
    channel.value === Channel.Clash && (core.value === Core.Singbox || core.value === Core.Honk),
)

const isForkCoreOverride = computed(() => isNonMihomoClashCore.value && displayAllFeatures.value)

// 开关自身的可见性与其生效范围保持一致。
export const showDisplayAllFeatures = computed(
  () => !!activeBackend.value && isNonMihomoClashCore.value,
)

const hard = computed(() => {
  const clash = !!activeBackend.value && channel.value === Channel.Clash
  const singbox = !!activeBackend.value && channel.value === Channel.Singbox

  return {
    // 弃用公告要覆盖两种 sing-box 用法:原生 gRPC 通道同步可知；Clash 兼容
    // 通道则等版本探测确认内核后再提示。
    singboxDeprecationNotice: singbox || core.value === Core.Singbox,
    rules: clash,
    dnsQuery: clash,
    dnsFlush: clash,
    fakeIPFlush: clash,
    coreActions: clash,

    tools: singbox,
    goroutines: singbox,
    startedAt: singbox,
    usbip: singbox && apiVersion.value >= USBIP_MIN_API_VERSION,
    openvpn: singbox && apiVersion.value >= OPENVPN_MIN_API_VERSION,
    taildrop: singbox && apiVersion.value >= TAILDROP_MIN_API_VERSION,
  }
})

const soft = computed(() => {
  const singbox = core.value === Core.Singbox
  const mihomo = core.value === Core.Mihomo
  const honk = core.value === Core.Honk
  const mihomoOrForkCore = mihomo || isForkCoreOverride.value

  return {
    coreUpgrade: mihomoOrForkCore,
    coreRestart: mihomoOrForkCore,
    dashboardUpgrade: mihomoOrForkCore,
    reloadConfigs: mihomoOrForkCore,
    updateConfigs: mihomoOrForkCore,
    updateGeoDatabase: mihomoOrForkCore,
    syncSettings: mihomoOrForkCore,
    independentLatency: mihomoOrForkCore,
    coreUpdateCheck: mihomo,
    configPatch: mihomo,

    // ---------- sing-box 内核侧 ----------
    // 自定义全局节点
    customGlobalNode: singbox,
    // sing-box 日志 payload 带 "[type]:" 前缀,可据此做类型分面过滤
    logTypeFilter: singbox,
    // sing-box 日志以 "[连接id 耗时]" 开头,可据此从日志跳到对应连接
    logConnectionDetail: singbox,
    // sing-box 切换模式后需要主动断开命中 clash_mode 规则的连接
    disconnectOnModeChange: singbox,

    // ---------- 日志级别集合 ----------
    // trace:sing-box 与 honk 有,mihomo 没有
    traceLogLevel: singbox || honk,
    // fatal / panic:仅 sing-box
    extraLogLevels: singbox,
    // silent:mihomo 与 sing-box 有,honk 没有
    silentLogLevel: mihomo || singbox,

    runtimeStats: honk,
  }
})

type HardCaps = typeof hard.value
type SoftCaps = typeof soft.value

export type HardCap = keyof HardCaps
export type SoftCap = keyof SoftCaps
export type Cap = HardCap | SoftCap

export const can = (cap: Cap): boolean => {
  if (!activeBackend.value) return false

  const hardCaps = hard.value

  if (cap in hardCaps) return hardCaps[cap as HardCap]

  return soft.value[cap as SoftCap]
}
