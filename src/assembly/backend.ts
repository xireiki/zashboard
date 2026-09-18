import { displayAllFeatures } from '@/store/settings'
import { activeBackend } from '@/store/setup'
import { computed, ref } from 'vue'
import { daeCapabilities } from './capabilities'

// usbip 需要 sing-box gRPC API v2(ProvideUSBDevices 流)
const USBIP_MIN_API_VERSION = 2
// OpenVPN 需要 sing-box gRPC API v3(SubscribeOpenVPNStatus 流)
const OPENVPN_MIN_API_VERSION = 3
// Taildrop 需要 sing-box gRPC API v4(SubscribeTaildropInbox / SendTaildropFiles 等)
const TAILDROP_MIN_API_VERSION = 4

export enum Channel {
  Clash = 'clash',
  Singbox = 'singbox',
  Dae = 'dae',
}

export enum Core {
  Mihomo = 'mihomo',
  Singbox = 'singbox',
  Honk = 'honk',
  Dae = 'dae',
  Unknown = 'unknown',
}

export const channel = computed<Channel>(() => {
  if (activeBackend.value?.type === 'singbox') return Channel.Singbox
  if (activeBackend.value?.type === 'dae') return Channel.Dae
  return Channel.Clash
})

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

// 通道级能力:与内核探测结果无关,只看当前后端是不是原生 sing-box gRPC 通道。
// 这些端点只存在于 gRPC 协议里,Clash 兼容通道上即便内核是 sing-box 也没有。
const hard = computed(() => {
  const singbox = !!activeBackend.value && channel.value === Channel.Singbox

  return {
    // 弃用公告要覆盖两种 sing-box 用法:原生 gRPC 通道同步可知；Clash 兼容
    // 通道则等版本探测确认内核后再提示。
    singboxDeprecationNotice: singbox || core.value === Core.Singbox,
    tools: singbox,
    goroutines: singbox,
    startedAt: singbox,
    usbip: singbox && apiVersion.value >= USBIP_MIN_API_VERSION,
    openvpn: singbox && apiVersion.value >= OPENVPN_MIN_API_VERSION,
    taildrop: singbox && apiVersion.value >= TAILDROP_MIN_API_VERSION,
  }
})

export type Cap =
  | 'coreUpgrade'
  | 'coreRestart'
  | 'dashboardUpgrade'
  | 'reloadConfigs'
  | 'updateConfigs'
  | 'updateGeoDatabase'
  | 'syncSettings'
  | 'independentLatency'
  | 'coreUpdateCheck'
  | 'configPatch'
  | 'coreActions'
  | 'customGlobalNode'
  | 'logTypeFilter'
  | 'logConnectionDetail'
  | 'disconnectOnModeChange'
  | 'traceLogLevel'
  | 'extraLogLevels'
  | 'silentLogLevel'
  | 'runtimeStats'
  | 'latencyTest'
  | 'proxyProviderUpdate'
  | 'proxyProviderHealthCheck'
  | 'ruleProviders'
  | 'flushDNSCache'
  | 'flushFakeIP'
  | 'dnsQuery'
  | 'connectionsClose'
  | 'connectionsFilterClose'
  | 'customTestUrl'
  | 'nodeLatencyTest'
  | 'rules'
  | 'metricsHistory'
  | 'backendEvents'
  | 'flows'
  | 'dnsCache'
  | 'dnsLog'
  | 'routingTrace'
  | 'datapath'
  | 'runtimeSettings'
  | 'configSources'
  | 'configEdit'
  | 'entryManage'
  | 'groupConfigPatch'
  | 'lifecycleControl'
  | 'singboxDeprecationNotice'
  | 'tools'
  | 'goroutines'
  | 'startedAt'
  | 'usbip'
  | 'openvpn'
  | 'taildrop'

type Caps = Partial<Record<Cap, boolean>>

const clashCaps = computed<Caps>(() => {
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

    // ---------- sing-box 内核侧(Clash 兼容通道) ----------
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

    rules: true,
    coreActions: true,

    latencyTest: true,
    proxyProviderUpdate: true,
    proxyProviderHealthCheck: true,
    ruleProviders: true,
    flushDNSCache: true,
    flushFakeIP: true,
    dnsQuery: true,
    connectionsClose: true,
    customTestUrl: true,
    nodeLatencyTest: true,
  }
})

const daeCaps = computed<Caps>(() => {
  const resources = daeCapabilities.value?.resources

  return {
    rules: true,
    coreActions: true,

    reloadConfigs: resources?.reload.available === true,
    updateGeoDatabase: resources?.geodata.can_update === true,

    traceLogLevel: resources?.logs.levels?.includes('trace') === true,

    runtimeStats: resources?.runtime_outbounds.available === true,

    latencyTest: resources?.probes.available === true,
    proxyProviderUpdate: resources?.providers.can_refresh === true,
    flushDNSCache: resources?.dns_cache.flush === true,
    dnsQuery: resources?.dns_query.available === true,
    connectionsClose: resources?.connections.can_close === true,
    connectionsFilterClose: resources?.connections.can_close === true,
    metricsHistory:
      resources?.traffic_history.available === true || resources?.memory_history.available === true,
    backendEvents: resources?.events.available === true,
    flows: resources?.flows.available === true,
    dnsCache: resources?.dns_cache.read === true,
    dnsLog: resources?.dns_log.available === true,
    routingTrace: resources?.routing_trace.available === true,
    datapath: resources?.datapath.available === true,
    runtimeSettings: resources?.runtime_settings.available === true,
    configSources: resources?.config.available === true,
    configEdit: resources?.config.writable === true && resources?.config.content === true,
    entryManage: resources?.nodes.can_manage === true || resources?.providers.can_manage === true,
    groupConfigPatch: resources?.groups.config_patch === true,
    lifecycleControl: resources?.suspend.available === true && resources?.resume.available === true,
  }
})

// 原生 sing-box gRPC 通道:Clash 概念(规则/配置/DNS 缓存)在这里不存在,
// 只保留 sing-box 自身内核侧能力。
const singboxCaps = computed<Caps>(() => ({
  customGlobalNode: true,
  logTypeFilter: true,
  logConnectionDetail: true,
  disconnectOnModeChange: true,
  traceLogLevel: true,
  extraLogLevels: true,
  silentLogLevel: true,
}))

const soft = computed<Caps>(() => {
  if (channel.value === Channel.Dae) return daeCaps.value
  if (channel.value === Channel.Singbox) return singboxCaps.value
  return clashCaps.value
})

export const can = (cap: Cap): boolean => {
  if (!activeBackend.value) return false

  const hardCaps = hard.value

  if (cap in hardCaps) return hardCaps[cap as keyof typeof hardCaps]

  return soft.value[cap] === true
}
